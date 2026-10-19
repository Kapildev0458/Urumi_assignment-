#!/bin/sh
# Installs and configures WordPress + WooCommerce. Runs as a Helm post-install/upgrade hook.
# Every step checks state first, so re-running (retries, upgrades) is always safe.
set -eu

log() { echo "[setup] $*"; }
WP_USER_ARG="--user=$WP_ADMIN_USER"

log "waiting for database at $WORDPRESS_DB_HOST"
until php -r '
  mysqli_report(MYSQLI_REPORT_OFF);
  [$host, $port] = array_pad(explode(":", getenv("WORDPRESS_DB_HOST")), 2, 3306);
  $c = @mysqli_connect($host, getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME"), (int) $port);
  exit($c ? 0 : 1);'; do
  sleep 5
done

# The WordPress pod copies its bundled themes/plugins into the shared wp-content volume on
# start; wait for it so both pods agree on the volume contents.
log "waiting for WordPress at $WP_SERVICE_URL"
until php -r 'exit(@file_get_contents(getenv("WP_SERVICE_URL") . "/wp-includes/images/blank.gif") === false ? 1 : 0);'; do
  sleep 5
done

if wp core is-installed; then
  log "WordPress already installed; syncing admin password from the Secret"
  wp user update "$WP_ADMIN_USER" --user_pass="$WP_ADMIN_PASSWORD" --skip-email
  # A new image tag brings new core files; migrate the database schema to match.
  wp core update-db
else
  log "installing WordPress at $SITE_URL"
  wp core install --url="$SITE_URL" --title="$STORE_TITLE" \
    --admin_user="$WP_ADMIN_USER" --admin_password="$WP_ADMIN_PASSWORD" \
    --admin_email="$WP_ADMIN_EMAIL" --skip-email
fi

log "permalinks (needed for /wp-json/ REST routes)"
wp rewrite structure '/%postname%/'

log "theme: storefront"
wp theme is-installed storefront || wp theme install storefront
wp theme activate storefront

if ! wp plugin is-installed woocommerce; then
  log "installing WooCommerce ${WOO_VERSION:-latest}"
  if [ -n "$WOO_VERSION" ]; then
    wp plugin install woocommerce --version="$WOO_VERSION"
  else
    wp plugin install woocommerce
  fi
elif [ -n "$WOO_VERSION" ] && [ "$(wp plugin get woocommerce --field=version)" != "$WOO_VERSION" ]; then
  log "switching WooCommerce to pinned version $WOO_VERSION"
  wp plugin install woocommerce --version="$WOO_VERSION" --force
fi
wp plugin activate woocommerce
wp wc update || log "warning: 'wp wc update' failed (no pending DB migrations?)"

log "store settings"
wp option update woocommerce_coming_soon no            # new installs start hidden otherwise
wp option update woocommerce_store_pages_only no
wp option update woocommerce_onboarding_profile '{"skipped":true}' --format=json
wp option update woocommerce_currency "$STORE_CURRENCY"
wp option update woocommerce_default_country "$STORE_COUNTRY"
wp option update woocommerce_calc_taxes no
wp option update woocommerce_enable_guest_checkout yes
# Demo store: no shipping step, so checkout works for any product without zones/rates.
wp option update woocommerce_ship_to_countries disabled

log "payment: Cash on delivery"
wp option update woocommerce_cod_settings --format=json \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}'

log "shop / cart / checkout / my-account pages"
wp wc tool run install_pages "$WP_USER_ARG"

if [ "$SAMPLE_PRODUCT" = "true" ] && [ -z "$(wp wc product list "$WP_USER_ARG" --format=ids)" ]; then
  log "creating sample product"
  wp wc product create "$WP_USER_ARG" --name="Urumi Starter Mug" --regular_price=12.50 \
    --status=publish --description="A sample product created by the store setup job."
fi

log "registering REST API key for the MCP server"
wp eval-file /scripts/api-key.php

wp rewrite flush
wp cache flush
log "done: storefront $SITE_URL  admin $SITE_URL/wp-admin  (user: $WP_ADMIN_USER)"

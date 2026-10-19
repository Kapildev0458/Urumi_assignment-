<?php
/**
 * Registers the consumer key/secret from the Kubernetes Secret as a WooCommerce REST API key.
 * WooCommerce stores only an HMAC of the consumer key (wc_api_hash), exactly as if the key had
 * been created in WooCommerce > Settings > Advanced > REST API. Delete-then-insert keeps this
 * idempotent and also applies a rotated key from the Secret.
 */
global $wpdb;

$description = 'urumi-mcp';
$key    = getenv('WOO_CONSUMER_KEY');
$secret = getenv('WOO_CONSUMER_SECRET');
$user   = get_user_by('login', getenv('WP_ADMIN_USER'));

if (!$key || !$secret || !$user) {
    WP_CLI::error('Missing WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET or admin user.');
}

$table = $wpdb->prefix . 'woocommerce_api_keys';
$wpdb->delete($table, ['description' => $description]);
$ok = $wpdb->insert($table, [
    'user_id'         => $user->ID,
    'description'     => $description,
    'permissions'     => 'read_write',
    'consumer_key'    => wc_api_hash($key),
    'consumer_secret' => $secret,
    'truncated_key'   => substr($key, -7),
]);

if (!$ok) {
    WP_CLI::error('Could not insert API key: ' . $wpdb->last_error);
}
WP_CLI::success("REST API key '$description' registered (consumer key ends in " . substr($key, -7) . ').');

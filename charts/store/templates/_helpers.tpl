{{- define "store.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "store.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "store.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "store.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{/* Usage: include "store.selectorLabels" (dict "ctx" . "component" "wordpress") */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/name: {{ include "store.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "store.host" -}}
{{- .Values.ingress.host | default (printf "%s.%s" .Values.ingress.hostPrefix .Values.global.domain) }}
{{- end }}

{{- define "store.url" -}}
{{- ternary "https" "http" .Values.ingress.tls.enabled }}://{{ include "store.host" . }}
{{- end }}

{{- define "store.mariadbService" -}}
{{- printf "%s-mariadb" (include "store.fullname" .) }}
{{- end }}

{{- define "store.wordpressService" -}}
{{- printf "%s-wordpress" (include "store.fullname" .) }}
{{- end }}

{{- define "store.credentialsSecret" -}}
{{- .Values.credentials.existingSecret | default (printf "%s-credentials" (include "store.fullname" .)) }}
{{- end }}

{{- define "store.wooApiSecret" -}}
{{- .Values.wooApi.existingSecret | default (printf "%s-woo-api" (include "store.fullname" .)) }}
{{- end }}

{{/*
Environment shared by the WordPress pod and the WP-CLI setup job. The official image turns
these into wp-config.php (wp-config-docker.php reads them with getenv).
*/}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: "{{ include "store.mariadbService" . }}:3306"
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.credentialsSecret" . }}
      key: mariadb-password
{{- range $salt := list "auth-key" "secure-auth-key" "logged-in-key" "nonce-key" "auth-salt" "secure-auth-salt" "logged-in-salt" "nonce-salt" }}
- name: WORDPRESS_{{ $salt | replace "-" "_" | upper }}
  valueFrom:
    secretKeyRef:
      name: {{ include "store.credentialsSecret" $ }}
      key: {{ $salt }}
{{- end }}
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', '{{ include "store.url" . }}');
    define('WP_SITEURL', '{{ include "store.url" . }}');
    define('WP_MEMORY_LIMIT', '256M');
    // Core is upgraded by changing the image tag, not from inside the pod.
    define('AUTOMATIC_UPDATER_DISABLED', true);
    {{- with .Values.wordpress.extraConfig }}
    {{- nindent 4 . }}
    {{- end }}
{{- end }}

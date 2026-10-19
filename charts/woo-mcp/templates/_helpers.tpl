{{- define "woo-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "woo-mcp.fullname" -}}
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

{{- define "woo-mcp.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "woo-mcp.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{/* component=woo-mcp is what the store's NetworkPolicy allows to reach WordPress. */}}
{{- define "woo-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "woo-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: woo-mcp
{{- end }}

{{- define "woo-mcp.authSecret" -}}
{{- .Values.auth.existingSecret | default (printf "%s-auth" (include "woo-mcp.fullname" .)) }}
{{- end }}

{{- define "woo-mcp.storeServiceUrl" -}}
{{- .Values.store.serviceUrl | default (printf "http://%s-store-wordpress" .Release.Name) }}
{{- end }}

{{- define "woo-mcp.storePublicUrl" -}}
{{- .Values.store.publicUrl | default (printf "http://store.%s" .Values.global.domain) }}
{{- end }}

{{- define "woo-mcp.storeApiSecret" -}}
{{- .Values.store.apiSecret | default (printf "%s-store-woo-api" .Release.Name) }}
{{- end }}

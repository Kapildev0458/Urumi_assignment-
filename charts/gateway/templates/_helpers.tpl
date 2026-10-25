{{- define "gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "gateway.fullname" -}}
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

{{- define "gateway.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: urumi
{{- end }}

{{/*
Selector labels for one component. component=gateway is what every upstream MCP server's
NetworkPolicy admits. Usage: include "gateway.selectorLabels" (dict "ctx" . "component" "gateway")
*/}}
{{- define "gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gateway.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "gateway.dbService" -}}
{{- printf "%s-db" (include "gateway.fullname" .) }}
{{- end }}

{{- define "gateway.secret" -}}
{{- printf "%s-secrets" (include "gateway.fullname" .) }}
{{- end }}

{{- define "gateway.llmSecret" -}}
{{- .Values.llm.secretName | default (printf "%s-llm" (include "gateway.fullname" .)) }}
{{- end }}

{{- define "gateway.host" -}}
{{- .Values.ingress.host | default (printf "%s.%s" .Values.ingress.hostPrefix .Values.global.domain) }}
{{- end }}

{{- define "gateway.publicUrl" -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) (include "gateway.host" .) }}
{{- end }}

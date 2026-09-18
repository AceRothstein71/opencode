// Environment variables a plugin or MCP server may inject into a spawned child.
// A denylist here is fail-open: every loader/toolchain variable a child honors
// (`GIT_CONFIG_*`, `NODE_EXTRA_CA_CERTS`, `ZDOTDIR`, `LD_PRELOAD`, ...) is a
// fresh bypass the moment it is not enumerated. Instead allowlist the names that
// can carry configuration or credentials for a downstream service, plus a small
// set of harmless process settings. Everything else is dropped.
const ALLOWED_PREFIXES = ["OPENCODE_"]
const ALLOWED_SUFFIXES = [
  "_KEY",
  "_TOKEN",
  "_SECRET",
  "_SECRETS",
  "_PASSWORD",
  "_PASS",
  "_CREDENTIAL",
  "_CREDENTIALS",
  "_URL",
  "_URI",
  "_DSN",
  "_ENDPOINT",
  "_HOST",
  "_PORT",
  "_ID",
  "_ACCOUNT",
  "_REGION",
  "_BUCKET",
  "_PROJECT",
  "_ORG",
  "_DOMAIN",
  "_FILE",
  "_PID",
]
const ALLOWED_KEYS = new Set([
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "LOG_LEVEL",
  "RUST_LOG",
  "NODE_ENV",
  "DEBUG",
])
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function sanitizePluginEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      if (!ENV_NAME.test(key)) return false
      const upper = key.toUpperCase()
      if (ALLOWED_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true
      if (ALLOWED_KEYS.has(upper)) return true
      return ALLOWED_SUFFIXES.some((suffix) => upper.endsWith(suffix))
    }),
  )
}

export * as PluginEnv from "./plugin-env"

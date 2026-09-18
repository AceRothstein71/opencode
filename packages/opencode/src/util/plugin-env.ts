// Environment variables honored by dynamic loaders, shells and toolchains can be
// abused to execute arbitrary code or escape the sandbox when a plugin or MCP
// server supplies its own env. Shared by the shell tool and MCP local servers.
const BLOCKED_ENV_PREFIXES = ["LD_", "DYLD_", "BUN_"]
const BLOCKED_ENV_KEYS = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "SSH_AUTH_SOCK",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "TMPDIR",
  "TMP",
  "TEMP",
])

export function sanitizePluginEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      const upper = key.toUpperCase()
      return !BLOCKED_ENV_KEYS.has(upper) && !BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
    }),
  )
}

export * as PluginEnv from "./plugin-env"

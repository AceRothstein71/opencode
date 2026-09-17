export function collapseToolOutput(output: string, maxLines: number, maxChars: number) {
  const lines = output.split("\n", maxLines + 1)
  if (lines.length <= maxLines && output.length <= maxChars) {
    return { output, overflow: false }
  }

  const preview = lines.slice(0, maxLines).join("\n")
  if (preview.length > maxChars) {
    const bounded = Array.from(preview.slice(0, maxChars * 2))
    if (bounded.length > maxChars) {
      return { output: bounded.slice(0, Math.max(0, maxChars - 1)).join("") + "…", overflow: true }
    }
  }

  return { output: [...lines.slice(0, maxLines), "…"].join("\n"), overflow: true }
}

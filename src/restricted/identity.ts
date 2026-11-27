/** Worker messages are untrusted: never spread them into the host registry. */
export function workerIdentity(value: unknown, runtime: "claude" | "codex"): { sessionId: string | null; started: boolean; workdir: string; providerHome: string } {
  const i = value as Record<string, unknown> | null;
  if (!i || !(i.sessionId === null || typeof i.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(i.sessionId)) || typeof i.started !== "boolean" || i.started && !i.sessionId || typeof i.workdir !== "string" || !i.workdir.startsWith("/") || i.workdir.length > 4096 || i.workdir.includes("\0") || i.providerHome !== `/user/${runtime}`) throw new Error("Invalid container conversation identity");
  return { sessionId: i.sessionId as string | null, started: i.started, workdir: i.workdir, providerHome: i.providerHome };
}

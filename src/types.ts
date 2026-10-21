export interface PaneInfo {
  pane_id: string;
  label: string;
  agent: string;
  tab_id: string;
  workspace_id: string;
  /** Display metadata only; binding still uses label or pane_id. */
  name?: string;
  title?: string;
  cwd?: string;
  /**
   * herdr's `agent_status`, verbatim.
   *
   * `done` is a real value this union used to omit: a pane that has finished a
   * turn whose result nobody has looked at yet. It is sticky — observed
   * holding for minutes — so it is a settled state rather than a step on the
   * way to `idle`, and everything here treats it as "not working".
   */
  status: "idle" | "working" | "done" | "blocked" | "unknown";
}

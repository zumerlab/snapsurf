// Nothing changes semantically: the CSS animation keeps running (infinite, 10s
// cycle — still mid-flight at both inspections). We only let a couple of frames
// elapse so the animated transform/opacity have advanced between snapshots.
export default async function mutate(_root, { frame }) {
  await frame()
  await frame()
}

const {spawnSync} = require("child_process")
const path = require("path")

test("current Events API payloads work in activity and recent language analysis", () => {
  const result = spawnSync(process.execPath, ["--experimental-vm-modules", "--test", path.join(__dirname, "fixtures/events-api.mjs")], {encoding: "utf8"})
  if (result.status !== 0)
    console.error(result.stdout, result.stderr)
  expect(result.status).toBe(0)
})

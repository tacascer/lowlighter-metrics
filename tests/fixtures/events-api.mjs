import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { test } from "node:test"
import vm from "node:vm"
import activity from "../../source/plugins/activity/index.mjs"

//Keep the real analyzer and local API adapters; replace only unrelated engine dependencies.
const modules = new Map()
async function load(url) {
  if (modules.has(url.href))
    return modules.get(url.href)
  const module = new vm.SourceTextModule(await fs.readFile(url, "utf8"), {identifier: url.href})
  modules.set(url.href, module)
  await module.link(async (specifier, parent) => {
    const exports = specifier === "linguist-js"
      ? {default: null}
      : specifier.endsWith("/utils.mjs")
      ? {filters: {text: (text, patterns) => !patterns.includes(`${text}`.toLowerCase())}}
      : specifier === "./analyzer.mjs"
      ? {Analyzer: class {}}
      : null
    if (!exports)
      return load(new URL(specifier, parent.identifier))
    return new vm.SyntheticModule(Object.keys(exports), function() {
      for (const [name, value] of Object.entries(exports))
        this.setExport(name, value)
    })
  })
  return module
}
const module = await load(new URL("../../source/plugins/languages/analyzer/recent.mjs", import.meta.url))
await module.evaluate()
const {RecentAnalyzer} = module.namespace

const before = "a".repeat(40), head = "b".repeat(40)
const event = payload => ({type: "PushEvent", actor: {login: "alice"}, repo: {name: "alice/example"}, created_at: "2026-10-18T12:00:00Z", public: true, payload: {ref: "refs/heads/main", before, head, ...payload}})
const detail = (sha = head, login = "alice") => ({
  sha,
  url: `https://api.github.com/repos/alice/example/commits/${sha}`,
  author: {login},
  parents: [{}],
  commit: {message: `Commit ${sha[0]}`, author: {name: "Alice", email: "alice@example.com"}, committer: {name: "Alice", email: "alice@example.com", date: "2026-10-18T12:00:00Z"}, verification: {verified: true}},
  files: [{filename: "example.rs", patch: "+let x = 1;\n-old"}],
})
function api(events = [event()]) {
  const calls = []
  const rest = {
    activity: {listEventsForAuthenticatedUser: async () => ({data: events})},
    repos: {
      compareCommitsWithBasehead: async args => {
        calls.push(["compare", args])
        return {data: {commits: [detail()]}}
      },
      getCommit: async args => {
        calls.push(["commit", args])
        return {data: detail(args.ref)}
      },
    },
    pulls: {
      get: async args => {
        calls.push(["pull", args])
        return {data: {number: 1, user: {login: "alice"}, title: "Fix", body: "Details", additions: 2, deletions: 1, changed_files: 1, merged: true}}
      },
    },
    request: async () => ({data: detail()}),
  }
  return {rest, calls}
}
function analyzer(rest) {
  const instance = Object.create(RecentAnalyzer.prototype)
  Object.assign(instance, {
    days: 0,
    load: 100,
    context: {mode: "user"},
    account: "user",
    login: "alice",
    authoring: ["alice"],
    results: {},
    markers: {line: /^(?<op>[-+])\s*(?<content>[\s\S]+)$/},
    debug() {},
    ignore() {
      return false
    },
    rest,
  })
  return instance
}
function runActivity(rest) {
  return activity({
    login: "alice",
    data: {shared: {"repositories.skipped": [], "users.ignored": []}},
    rest,
    q: {activity: true},
    account: "user",
    imports: {
      metadata: {plugins: {activity: {enabled: () => true, inputs: () => ({limit: 10, load: 100, days: 0, filter: ["all"], visibility: "all", timestamps: false, skipped: [], ignored: []})}}},
      filters: {repo: () => true, text: () => true},
      markdown: async text => text,
      format: {error: error => error},
    },
  })
}

test("recent languages retrieves patches from current PushEvents", async () => {
  const {rest, calls} = api()
  const patches = await analyzer(rest).patches()
  assert.equal(patches.length, 1)
  assert.equal(patches[0].sha, head)
  assert.equal(patches[0].editions[0].added.lines, 1)
  assert.equal(patches[0].verified, true)
  assert.ok(calls.some(([type]) => type === "compare"))
})
test("activity retrieves current push summaries and counts", async () => {
  const {rest} = api()
  const result = await runActivity(rest)
  assert.equal(result.events[0].size, 1)
  assert.equal(result.events[0].commits[0].sha, head.slice(0, 7))
})
test("activity expands reduced pull request events", async () => {
  const {rest} = api([{...event(), type: "PullRequestEvent", payload: {action: "closed", number: 1, pull_request: {id: 10, number: 1, url: "https://api.github.com/repos/alice/example/pulls/1"}}}])
  const result = await runActivity(rest)
  assert.equal(result.events[0].title, "Fix")
  assert.equal(result.events[0].action, "merged")
})
test("recent languages excludes commits by other authors", async () => {
  const {rest} = api()
  rest.repos.getCommit = async () => ({data: {...detail(head, "bob"), commit: {...detail().commit, author: {name: "Bob", email: "bob@example.com"}}}})
  assert.equal((await analyzer(rest).patches()).length, 0)
})
test("legacy push summaries still work without a comparison", async () => {
  const {rest, calls} = api([event({size: 1, commits: [{sha: head, url: detail().url, message: "Legacy", author: {name: "Alice", email: "alice@example.com"}}]})])
  assert.equal((await analyzer(rest).patches()).length, 1)
  const result = await runActivity(rest)
  assert.equal(result.events[0].commits[0].message, "Legacy")
  assert.ok(!calls.some(([type]) => type === "compare"))
})
test("duplicate push events do not double count language patches", async () => {
  const {rest} = api([event(), event()])
  assert.equal((await analyzer(rest).patches()).length, 1)
})
test("unavailable pushes do not discard other activity", async () => {
  const {rest} = api([event(), {...event(), type: "WatchEvent", payload: {action: "started"}}])
  rest.repos.compareCommitsWithBasehead = async () => {
    throw Object.assign(new Error("gone"), {status: 404})
  }
  const result = await runActivity(rest)
  assert.deepEqual(result.events.map(({type}) => type), ["star"])
})
test("new branch pushes retrieve the head commit", async () => {
  const {rest, calls} = api([event({before: "0".repeat(40)})])
  assert.equal((await analyzer(rest).patches()).length, 1)
  assert.ok(!calls.some(([type]) => type === "compare"))
})
test("push comparisons paginate instead of truncating commits", async () => {
  const {rest} = api()
  rest.repos.compareCommitsWithBasehead = async ({page}) => ({data: {commits: page === 1 ? Array.from({length: 100}, (_, i) => detail(i.toString(16).padStart(40, "0"))) : [detail()]}})
  assert.equal((await analyzer(rest).patches()).length, 101)
})
test("repository events receive pagination parameters", async () => {
  const {rest} = api()
  rest.repos.get = async () => ({data: {default_branch: "main"}})
  const pages = []
  rest.activity.listRepoEvents = async args => {
    pages.push(args)
    return {data: []}
  }
  const instance = analyzer(rest)
  instance.context = {mode: "repository", owner: "alice", repo: "example"}
  instance.load = 200
  await instance.patches()
  assert.deepEqual(pages.map(({page, per_page}) => [page, per_page]), [[1, 100], [2, 100]])
})

test("authentication failures remain visible", async () => {
  const {rest} = api()
  rest.repos.compareCommitsWithBasehead = async () => {
    throw Object.assign(new Error("Bad credentials"), {status: 401})
  }
  await assert.rejects(runActivity(rest), {status: 401})
})
test("reduced review events retrieve their pull request", async () => {
  const {rest} = api([{...event(), type: "PullRequestReviewEvent", payload: {review: {state: "approved"}, pull_request: {number: 1}}}])
  const result = await runActivity(rest)
  assert.equal(result.events[0].type, "review")
  assert.equal(result.events[0].title, "Fix")
})
test("an unavailable pull request preserves unrelated events", async () => {
  const {rest} = api([{...event(), type: "PullRequestEvent", payload: {action: "closed", number: 1, pull_request: {number: 1}}}, {...event(), type: "WatchEvent", payload: {action: "started"}}])
  rest.pulls.get = async () => {
    throw Object.assign(new Error("gone"), {status: 404})
  }
  assert.deepEqual((await runActivity(rest)).events.map(({type}) => type), ["star"])
})

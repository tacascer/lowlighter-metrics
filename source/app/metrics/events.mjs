/**Resolve push summaries omitted from current Events API payloads. */
export async function pushCommits(rest, {repo: {name}, payload}) {
  if (Array.isArray(payload.commits))
    return payload.commits
  const [owner, repo] = name.split("/")
  const {before, head} = payload
  if ((!head) || (/^0+$/.test(head)))
    return []
  try {
    const commits = []
    if ((!before) || (/^0+$/.test(before))) {
      //A newly created branch has no previous tip to compare against.
      commits.push((await rest.repos.getCommit({owner, repo, ref: head})).data)
    }
    else {
      for (let page = 1;; page++) {
        const {data} = await rest.repos.compareCommitsWithBasehead({owner, repo, basehead: `${before}...${head}`, per_page: 100, page})
        commits.push(...data.commits)
        if (data.commits.length < 100)
          break
      }
    }
    return commits.map(({sha, url, commit: {message, author}}) => ({sha, url, message, author}))
  }
  catch (error) {
    //Deleted repositories and unreachable histories should not hide other events.
    if ([404, 409, 422].includes(error.status))
      return []
    throw error
  }
}

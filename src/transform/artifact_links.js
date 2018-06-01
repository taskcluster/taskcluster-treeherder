const path = require('path');
const taskcluster = require('taskcluster-client');

LOG_ARTIFACTS = {
    // XXX: This is a magical name see 1147958 which enables the log viewer.
    'public/logs/live_backing.log': 'builds-4h',
    'public/logs/chain_of_trust.log': 'chain-of-trust',
}

module.exports = async function(queue, monitor, taskId, runId, job) {
  let res;
  try {
    res = await queue.listArtifacts(taskId, runId);
  } catch (e) {
    monitor.reportError(e, {taskId, runId});
    return job;
  }

  let artifacts = res.artifacts;

  while (res.continuationToken) {
    let continuation = {continuationToken: res.continuationToken};

    try {
      res = await queue.listArtifacts(taskId, runId, continuation);
    } catch (e) {
      monitor.reportError(e, {taskId, runId});
      break;
    }

    artifacts = artifacts.concat(res.artifacts);
  }

  let seen = {};

  let links = artifacts.map((artifact) => {
    let url = `https://queue.taskcluster.net/v1/task/${taskId}` +
	       `/runs/${runId}/artifacts/${artifact.name}`;
    if (artifact.name in LOG_ARTIFACTS) {
	job.logs.push({
	    name: LOG_ARTIFACTS[artifact.name],
	    url: url,
	});
    }
    let name = path.parse(artifact.name).base;
    if (!seen[name]) {
      seen[name] = [artifact.name];
    } else {
      seen[name].push(artifact.name);
      name = `${name} (${seen[name].length-1})`;
    }
    let link = {
      label: 'artifact uploaded',
      linkText: name,
      url: url,
    };
    return link;
  });

  job.jobInfo.links = job.jobInfo.links.concat(links);

  return job;
}

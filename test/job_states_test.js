suite('end to end submission', function() {
  this.timeout(5 * 60 * 1000);

  var co          = require('co');
  var base        = require('taskcluster-base');
  var debug       = require('debug')('test:localhost');
  var taskcluster = require('taskcluster-client');
  var helper      = require('./helper');
  var request     = require('superagent-promise');
  var urljoin     = require('url-join');
  var Project     = require('mozilla-treeherder/project');
  var _           = require('lodash');
  var slugid      = require('slugid');
  var assert      = require('assert');
  var subject     = helper.setup({title: "localhost"});

  var TH_PROJECT = 'taskcluster-integration';

  function createTask(revisionHash, taskId, task) {
    var template = {
      provisionerId:  "not-a-real-provisioner",
      workerType:     "test",
      created:        new Date().toJSON(),
      deadline:       new Date(new Date().getTime() + 60 * 60 * 1000).toJSON(),
      routes: [
        [subject.routePrefix, TH_PROJECT, revisionHash].join('.')
      ],
      payload: {
        image:        "quay.io/mozilla/ubuntu:13.10",
        command: [
          "/bin/bash",
          "-c",
          "echo \"hi world\"; sleep 10; echo \"done\";"
        ],
        maxRunTime: 600
      },
      metadata: {
        name:         "Example Task",
        description:  "Markdown description of **what** this task does",
        owner:        "jonasfj@mozilla.com",
        source:       "http://docs.taskcluster.net/tools/task-creator/"
      },
      extra: {
        treeherder: {
          symbol:         "S",
          groupName:      "MyGroupName",
          groupSymbol:    "G",
          productName:    "MyProductName"
        }
      }
    };
    return subject.queue.createTask(taskId, _.merge(template, task || {}));
  }

  function createResultset(revisionHash, revision, details) {
    var template = {
      revision_hash:          revisionHash,
      author:                 "jonasfj@mozilla.com",
      push_timestamp:         Math.floor(new Date().getTime() / 1000),
      type:                   'push',
      revisions: [{
        comment:              "test of taskcluster-treeherder integration",
        files:                [],
        revision:             revision,
        repository:           "try",
        author:               "jonasfj@mozilla.com"
      }]
    };
    return project.postResultset([_.merge(template, details || {})]);
  }

  function getResultset(revisionHash) {
    var url = urljoin(
      subject.treeherderBaseUrl,
      'project/' + TH_PROJECT + '/resultset/'
    );
    return request
      .get(url)
      .query({
        count:          1,
        revision_hash:  revisionHash,
        with_jobs:      'true', // return jobs
        debug:          'true'  // Use objects instead of arrays
      })
      .end()
      .then(function(res) {
        if (res.status === 404) return null;
        if (res.error) throw res.error;
        return res.body;
      });
  }

  function getArtifacts(jobId) {
    var url = urljoin(
      subject.treeherderBaseUrl, 'project/' + TH_PROJECT + '/artifact/'
    );

    return request
      .get(url)
      .query({
        job_id: jobId
      })
      .end()
      .then(function(res) {
        if (res.error) throw res.error;
        // Map the result into key value pairs where the "key" is the title.
        return res.body.reduce(function(result, value) {
          var details = value.blob.job_details[0];
          result[details.title] = value;
          return result;
        }, {});
      });
  }

  function* waitForJobState(revisionHash, state) {
    var maxRetries = 100;

    function sleep(time, cb) {
      return setTimeout(cb, time);
    }

    var retry = 0;
    while (retry++ < maxRetries) {
      var resultset = (yield getResultset(revisionHash)).results[0];
      // If there is no job yet wait until a job is available.
      if (!resultset.platforms.length) {
        debug("No jobs waiting...");
        yield sleep.bind(null, 100);
        continue;
      }

      // Get the first job.
      var job = resultset.platforms[0].groups[0].jobs[0];
      if (job.state !== state) {
        debug("No job found but not in correct state", job.state, state);
        yield sleep.bind(null, 100);
        continue;
      }

      return job;
    }

    // The while loop should return the correct job or fail here.
    throw new Error('Job could not be found or job state is never set');
  }

  var projects;
  var project;
  setup(function() {
    projects = JSON.parse(subject.projects);
    project = new Project(TH_PROJECT, {
      consumerKey: projects[TH_PROJECT].consumer_key,
      consumerSecret: projects[TH_PROJECT].consumer_secret,
      baseUrl: subject.treeherderBaseUrl
    });
  });

  test('state changes to completed+success', co(function* () {
    // Create revision and revision hash for treeherder
    var revisionHash = slugid.decode(slugid.v4());
    var revision     = slugid.decode(slugid.v4());
    var taskId       = slugid.v4();

    // Create the treeherder results...
    var resultSet = yield createResultset(revisionHash, revision);

    // Create our initial task.
    var task = yield createTask(revisionHash, taskId);

    // Our task should now be in the "pending" state in treeherder.
    var job = yield waitForJobState(revisionHash, 'pending');

    // Claim the task so we can see a running state.
    yield subject.queue.claimTask(taskId, 0, {
      workerGroup: 'test',
      workerId: 'test'
    });

    // Ensure the task is now running...
    yield waitForJobState(revisionHash, 'running');

    // Mark the task as completed with success
    yield subject.queue.reportCompleted(taskId, 0, { success: true });

    // Success.
    var job = yield waitForJobState(revisionHash, 'completed');
    assert.equal(job.result, 'success');
    assert.ok(
      (yield getArtifacts(job.id))['Inspect Task'], 'task inspector link'
    );
  }));

  test('state changes to completed+failed', co(function* () {
    // Create revision and revision hash for treeherder
    var revisionHash = slugid.decode(slugid.v4());
    var revision     = slugid.decode(slugid.v4());
    var taskId       = slugid.v4();

    // Create the treeherder results...
    var resultSet = yield createResultset(revisionHash, revision);

    // Create our initial task.
    var task = yield createTask(revisionHash, taskId);

    // Our task should now be in the "pending" state in treeherder.
    var job = yield waitForJobState(revisionHash, 'pending');

    // Claim the task so we can see a running state.
    yield subject.queue.claimTask(taskId, 0, {
      workerGroup: 'test',
      workerId: 'test'
    });

    // Ensure the task is now running...
    yield waitForJobState(revisionHash, 'running');

    // Mark the task as completed with success.
    yield subject.queue.reportCompleted(taskId, 0, { success: false });

    // Failure states.
    var job = yield waitForJobState(revisionHash, 'completed');
    assert.equal(job.result, 'testfailed');
    assert.ok(
      (yield getArtifacts(job.id))['Inspect Task'], 'task inspector link'
    );
  }));
});

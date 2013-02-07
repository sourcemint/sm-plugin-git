
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs");
const EXEC = require("child_process").exec;
const SPAWN = require("child_process").spawn;
var Q = null;
var UTIL = null;
var TERM = null;
var WAITFOR = null;

// TODO: Clean this up!

exports.interfaceForPath = function(API, path, options) {
    ASSERT(typeof API === "object");
    Q = API.Q;
    UTIL = API.UTIL;
    TERM = API.TERM;
    WAITFOR = API.WAITFOR;
    return new Interface(path, options);
}


var Interface = function(path, options) {
    this.path = path;
    this.options = UTIL.copy(options || {});
    if (typeof this.options.verbose === "undefined") {
        this.options.verbose = false;
    }
}

Interface.prototype.isRepository = function(callback) {
    return PATH.exists(PATH.join(this.path, ".git"), function(exists) {
        return callback(null, exists);
    });
}

Interface.prototype.status = function(options, callback) {
    var self = this;

    options = options || {};
    return self.isRepository(function(err, isRepository) {
        if (err) return callback(err);
        if (!isRepository) {
            return callback(null, {
                "type": false
            });
        }
        return self.callGit([
            "status"
        ], {}, function(err, result) {
            if (err) return callback(err);
            var info = {
                    "type": "git",
                    "behind": false,
                    "ahead": false,
                    "dirty": true,
                    "tagged": false,
                    "tracking": false,
                    "branches": {},
                    "remoteBranches": [],
                    "tags": false,
                    "branch": false,
                    "rev": false
                },
                lines = result.split("\n"),
                index = 0,
                m = null;
            if(m = lines[index].match(/^# On branch (.*)$/)) {
                info.branch = m[1];
            } else
            if(m = lines[index].match(/^# Not currently on any branch.$/)) {
                info.branch = "rev";
            }

            index++;
            if(lines[index] && (m = lines[index].match(/^# Your branch and '[^']*' have diverged,/))) {
                info.ahead = true;
                info.behind = true;
                index += 3;
            } else
            if(lines[index] && (m = lines[index].match(/^# Your branch is ahead of /))) {
                info.ahead = true;
                index += 2;
            } else
            if(lines[index] && (m = lines[index].match(/^# Your branch is behind /))) {
                info.behind = true;
                index += 2;
            }
            if(lines[index] && (m = lines[index].match(/^nothing to commit \(working directory clean\)$/))) {
                info.dirty = false;
            }

            function proceed(callback) {
                if (info.branch === "rev") {
                    info.branch = info.rev;
                }

                return self.remotes(function(err, remotes) {
                    if (err) return callback(err);

                    if (remotes && remotes["origin"]) {
                        if (remotes["origin"].remoteBranches) {
                            info.remoteBranches = remotes["origin"].remoteBranches;
                        }
                        if (remotes["origin"].branches) {
                            info.branches = remotes["origin"].branches;                        
                            if (info.branches[info.branch] && info.branches[info.branch].tracking) {
                                info.tracking = info.branches[info.branch].remote;
                            }
                        }
                    }

                    return self.tags(function(err, tags) {
                        if (err) return callback(err);

                        if (tags && tags.tags) {
                            info.tags = tags.tags;
                        }

                        function proceed(callback) {

                            var noRemoteBranch = false;

                            function getDiff(comparator, callback) {
                                return self.callGit([
                                     "log",
                                     "--oneline",
                                     "-n", "10",
                                     comparator
                                ], {}, function(err, result) {
                                    if (err) {
                                        noRemoteBranch = true;
                                        return callback(null, []);
                                    }
                                    result = result.replace(/\n$/, "");
                                    if (!result) return callback(null, []);
                                    var lines = result.split("\n");
                                    if (lines.length === 0) return callback(null, false);
                                    lines = lines.map(function(line) {
                                        return line.match(/^([^\s]*)\s/)[1];
                                    });
                                    return callback(null, lines);
                                });
                            }

                            if (info.behind || info.ahead) {
                                return callback(null);
                            }

                            // The code below only applies if we are on a branch (as opposed to an exact ref).
                            if (info.branch === info.rev) {
                                return callback(null);
                            }

                            return getDiff("origin/" + info.branch + "..HEAD", function(err, toHeadLines) {
                                if (err) return callback(err);

                                if (noRemoteBranch) {
                                    info.ahead = true;
                                    info.noremote = true;
                                    return callback(null);
                                }

                                return getDiff("origin/" + info.branch + "..FETCH_HEAD", function(err, toFetchHeadLines) {
                                    if (err) return callback(err);
                                    return getDiff("HEAD..origin/" + info.branch, function(err, fromHeadLines) {
                                        if (err) return callback(err);
                                        return getDiff("FETCH_HEAD..origin/" + info.branch, function(err, fromFetchHeadLines) {
                                            if (err) return callback(err);

    /*
    console.log("toHeadLines", toHeadLines);
    console.log("toFetchHeadLines", toFetchHeadLines);
    console.log("fromHeadLines", fromHeadLines);
    console.log("fromFetchHeadLines", fromFetchHeadLines);
    */
                                            if (
                                                toHeadLines.length === 0 &&
                                                toFetchHeadLines.length === 0 &&
                                                fromHeadLines.length === 0
                                            ) {
                                                if (fromFetchHeadLines.length > 0) {
                                                    if (info.rev.substring(0, fromFetchHeadLines[0].length) !== fromFetchHeadLines[0]) {
                                                        // TODO: Verify.
                                                        info.behind = fromFetchHeadLines.length;
                                                    }
                                                }
                                                return callback(null);
                                            }

                                            if (
                                                toHeadLines.length > 0 &&
                                                toFetchHeadLines.length > 0 &&
                                                fromHeadLines.length === 0 &&
                                                fromFetchHeadLines.length === 0
                                            ) {
                                                if (toHeadLines[0] != toFetchHeadLines[0]) {
                                                    if (info.rev.substring(0, toHeadLines[0].length) === toHeadLines[0]) {
                                                        if (toHeadLines.indexOf(toFetchHeadLines[0]) !== -1) {
                                                            info.ahead = toHeadLines.length;
                                                        } else {
                                                            info.ahead = toHeadLines.length;
                                                            info.behind = toFetchHeadLines.length;
                                                        }
                                                    } else {
                                                        // TODO: Verify.
                                                        info.behind = toFetchHeadLines.length;
                                                    }
                                                }
                                                return callback(null);
                                            }

                                            if (
                                                toHeadLines.length > 0 &&
                                                toFetchHeadLines.length === 0 &&
                                                fromHeadLines.length === 0 &&
                                                fromFetchHeadLines.length === 0
                                            ) {
                                                info.ahead = toHeadLines.length;
                                                return callback(null);
                                            }

                                            if (
                                                toHeadLines.length === 0 &&
                                                fromFetchHeadLines.length === 0
                                            ) {
                                                if (
                                                    toFetchHeadLines.length > 0 &&
                                                    fromHeadLines.length === 0
                                                ) {
                                                    info.behind = toFetchHeadLines.length;
                                                } else
                                                if (
                                                    toFetchHeadLines.length === 0 &&
                                                    fromHeadLines.length > 0
                                                ) {
                                                    info.behind = fromHeadLines.length;
                                                }
                                                return callback(null);
                                            }

                                            if (
                                                toFetchHeadLines.length === 0 &&
                                                fromHeadLines.length > 0 &&
                                                fromFetchHeadLines.length === 0
                                            ) {
                                                if (toHeadLines.length > 0) {
                                                    info.ahead = toHeadLines.length;
                                                }
                                                info.behind = fromHeadLines.length;
                                                return callback(null);
                                            }

                                            return callback(null);
                                         });
                                    });
                                });
                            });
                        }

                        return self.isTagged(null, options, function(err, isTagged) {
                            if (err) return callback(err);
                            if (isTagged) {
                                info.tagged = isTagged;
                            }
                            return proceed(callback);
                        });
                    });
                });
            }

            options.mode = "exec";

            function finalize(err) {
                if (err) return callback(err);
                return callback(null, info);
            }

            return self.callGit([
                 "rev-parse",
                 "HEAD"
            ], options, function(err, result) {
                if (err) {
                    if (/fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree./.test(err.message)) {
                        return proceed(finalize);
                    }
                    return callback(err);
                }
                info.rev = result.replace(/\n$/, "");
                return proceed(finalize);
            });
        });
    });
}

Interface.prototype.isTagged = function(rev, options, callback) {
    if (typeof options === "undefined") {
        options = rev;
        rev = undefined;
    }
    var args = [
         "describe",
         "--tags"
    ];
    if (rev) {
        args.push(rev);
    }
    var self = this;
    this.callGit(args, options, function(err, result) {
        if (err) {
            // Happens if there are no tags in repo.
            // NOTE: Sometimes `git describe --tags <non-existent-rev>` exits with code 128 (git did not exit cleanly)
            //       instead of code 1 and buffer `fatal: No names found, cannot describe anything.`.
            // @issue https://github.com/sourcemint/sm/issues/3
            if (/fatal: No names found, cannot describe anything.|\(exit code 128\)/.test(err.message)) {
                return callback(null, false);
            }
            if (/fatal: No tags can describe/.test(err.message)) {
                return callback(null, false);
            }
            return callback(err);
        }
        result = result.replace(/\n$/, "");
        if (result) {
            if (rev) {
                // If this matches the rev is not tagged
                if (/^.*?-\d*-[^-]*$/.test(result)) {
                    return callback(null, false);
                }
                return callback(null, result);
            } else {
                // If this matches the tag is not for the latest commit.
                if (/^.*?-\d*-[^-]*$/.test(result)) {
                    return callback(null, false);
                }
                return callback(null, result);
            }
        }
        return callback(null, false);
    });
}

Interface.prototype.show = function(treeish, file, options, callback) {
    var self = this;
    self.callGit([
        "show",
        treeish + ":" + file
    ], options, function(err, result) {
        if (err) return callback(null, false);
        return callback(null, result);
    });
}

Interface.prototype.clone = function(url, options) {
    var self = this;
    options = options || {};
    options.cwd = options.cwd || PATH.dirname(self.path);
    if (PATH.existsSync(self.path)) {
        return Q.reject(new Error("Error cloning git repository. Target path '" + self.path + "' already exists!"));
    }
    var deferred = Q.defer();
    self.callGit([
        "clone",
        "--progress",
        url,
        PATH.basename(self.path)
    ], options, function(err, result) {
        if (err) return deferred.reject(err);
        // TODO: Detect more failure?
        return deferred.resolve();
    });
    return deferred.promise;
}

Interface.prototype.fetch = function(remote, options) {
    var self = this;
    options = options || {};
    options.cwd = options.cwd || self.path;
    var branch = null;
    if (UTIL.isArrayLike(remote)) {
        branch = remote[1];
        remote = remote[0];
    }
    var args = [
        "fetch",
        remote
    ];
    if (branch !== null) {
        args.push(branch);
    }
    if (options.tags) {
        args.push("--tags");
    }
    var deferred = Q.defer();
    self.callGit(args, options, function(err, result) {
        if (err) return deferred.reject(err);
        // TODO: Detect more failure?
        if (UTIL.trim(result) === "") {
            return deferred.resolve(304);
        }
        return deferred.resolve(200);
    });
    return deferred.promise;
}

Interface.prototype.remotes = function(callback) {
    var self = this;
    return self.isRepository(function(err, isRepository) {
        if (err) return callback(err);
        if (!isRepository) {
            return callback(new Error("Not a git repository: " + self.path));
        }
        return self.callGit([
            "remote",
            "show"
        ], {}, function(err, result) {
            if (err) return callback(err);
            var remotes = {};
            var waitfor = WAITFOR.serial(function(err) {
                if (err) return callback(err);
                return callback(null, remotes);
            });
            result.split("\n").map(function(remote) {
                if (! (remote = UTIL.trim(remote))) return;
                waitfor(function(done) {
                    return self.callGit([
                        "remote",
                        "show",
                        "-n",
                        remote
                    ], {}, function(err, result) {
                        if (err) return done(err);
                        remotes[remote] = {
                            "fetch-url": result.match(/Fetch URL: ([^\n]*)\n/)[1],
                            "push-url": result.match(/Push  URL: ([^\n]*)\n/)[1],
                            "branches": {},
                            "remoteBranches": []
                        };
                        var section = null;
                        result.split("\n").forEach(function(line) {
                            if (/Remote branch(?:es)?/.test(line)) {
                                section = "remote-branches";
                            } else
                            if (/Local branch(?:es)? configured for 'git pull':/.test(line)) {
                                section = "git-pull";
                            } else
                            if (/Local ref configured for 'git push'/.test(line)) {
                                section = "git-push";
                            } else
                            if (section === "remote-branches") {
                                var m = line.match(/^\s*([^\s]*)$/);
                                if (m) {
                                    remotes[remote].remoteBranches.push(m[1]);
                                }
                            } else
                            if (section === "git-pull") {
                                var m = line.match(/^\s*([^\s]*)\s.*?([^\s]*)$/);
                                if (m) {
                                    remotes[remote].branches[m[1]] = {
                                        tracking: true,
                                        remote: m[2]
                                    };
                                }
                            }
                        });
                        return done();
                   });
                });
            });
            waitfor();
        });
    });
}


Interface.prototype.setRemote = function(name, uri) {
    var self = this;
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        return self.callGit([
            "remote",
            "set-url",
            "--push",
            name,
            uri
        ], {}, function(err, result) {
            if (err) return deferred.reject(err);
            // TODO: Detect more failure?
            return deferred.resolve();
        });
    });
    return deferred.promise;
}


Interface.prototype.pull = function(remote, ref, options) {
    var self = this;
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        var args = [
            "pull",
            remote
        ];
        if (ref) {
            args.push(ref);
        }
        return self.callGit(args, options, function(err, result) {
            if (err) return deferred.reject(err);
            // TODO: Detect more failure?
            return deferred.resolve();
        });
    });
    return deferred.promise;
}


Interface.prototype.containsRef = function(ref) {
    var self = this;
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        return self.callGit([
            "branch",
            "--contains",
            ref
        ], {
            verbose: false
        }, function(err, result) {
            if (err) {
                if (/error: no such commit/.test(err.message)) {
                    return deferred.resolve(false);
                }
                if (/error: malformed object name/.test(err.message)) {
                    return deferred.resolve(false);
                }
                return deferred.reject(err);
            }
            var branches = [];
            result.replace(/\n$/, "").split("\n").forEach(function(branch) {
                branches.push(branch.replace(/^\s*\*?\s*/, ""));
            });
            return deferred.resolve(branches);
        });
    });
    return deferred.promise;
}

Interface.prototype.branch = function(name, options) {
    var self = this;
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        if(options.track) {
            return self.callGit([
                "branch",
                "--track", options.track,
                name
            ], {}, function(err, result) {
                if (err) return deferred.reject(err);
                var parts = name.split("/");
                if (!/Branch [^\s]* set up to track remote branch [^\s]* from/.test(result)) {
                    return deferred.reject(new Error("Error creating tracking branch: " + result));
                }
                return deferred.resolve();
            });
        } else {
            return self.callGit([
                "branch",
                name
            ], {}, function(err) {
                if (err) return deferred.reject(err);
                return deferred.resolve();
            });
        }
    });
    return deferred.promise;
}

Interface.prototype.checkout = function(ref, options) {
    var self = this;
    options = options || {};
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        if (options.symbolic) {

            return self.remotes(function(err, remotes) {
                if (err) return deferred.reject(err);

                function convertToRef(callback) {
                    // Convert to ref but only if `ref` is not a local branch.
                    if (!remotes || !remotes["origin"] || !remotes["origin"].branches[ref]) {
                        return self.callGit([
                            "rev-parse",
                            ref
                        ], {}, function(err, result) {
                            if (err) return callback(err);
                            ref = result.replace(/\n$/, "");
                            return callback(null);
                        });
                    }
                    return callback(null);
                }

                function reset(err) {
                    if (err) return deferred.reject(err);
                    return self.callGit([
                        "reset"
                    ], {}, function(err) {
                        if (err) return deferred.reject(err);
                        return deferred.resolve();
                    });
                }

                return convertToRef(function(err) {
                    if (err) return deferred.reject();

                    if (ref.length === 40) {
                        FS.writeFileSync(PATH.join(self.path, ".git/HEAD"), ref);
                        return reset(null);
                    } else {
                        return self.callGit([
                            "symbolic-ref",
                            "HEAD",
                            "refs/heads/" + ref
                        ], {}, reset);
                    }
                });
            });

        } else {
            return self.callGit([
                "checkout",
                ref
            ], {}, function(err, result) {
                if (err) return deferred.reject(err);
                // TODO: Detect more failure?
                return deferred.resolve();
            });
        }
    });
    return deferred.promise;
}


Interface.prototype.tags = function(callback) {
    var self = this;
    return self.isRepository(function(err, isRepository) {
        if (err) return callback(err);
        if (!isRepository) {
            return callback(new Error("Not a git repository: " + self.path));
        }
        return self.callGit([
            "tag"
        ], {}, function(err, result) {
            if (err) return callback(err);
            return callback(null, {
                tags: UTIL.map(result.split("\n"), function(version) {
                    return UTIL.trim(version);
                }).filter(function(version) {
                    if (version === "") return false;
                    return true;
                })
            });
        });
    });
}

Interface.prototype.tag = function(tag) {
    var self = this;
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        return self.callGit([
            "tag",
            tag
        ], {}, function(err, result) {
            if (err) return deferred.reject(err);
            return self.tags(function(err, info) {
                if (err) return deferred.reject(err);
                if (!info.tags) {
                    return deferred.reject(new Error("Error tagging. No tags found when verifying!"));
                }
                if (info.tags.indexOf(tag) === -1) {
                    return deferred.reject(new Error("Error tagging. New tag not found when verifying!"));
                }
                return deferred.resolve();
            });
        });
    });
    return deferred.promise;
}

Interface.prototype.push = function(options) {
    var self = this;
    try {
        ASSERT(typeof options.branch !== "undefined", "'options.branch' not set!");
        ASSERT(typeof options.remote !== "undefined", "'options.remote' not set!");
    } catch(err) {
        return Q.reject(err);
    }
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        var args = [
            "push",
            options.remote,
            options.branch
        ];
        if (options.tags) {
            args.push("--tags");
        }
        return self.callGit(args, {}, function(err, result) {
            if (err) return deferred.reject(err);
            // TODO: Verify that push was successful?
            return deferred.resolve();
        });
    });
    return deferred.promise;
}

Interface.prototype.canPush = function() {
    return this.push({
        remote: "origin",
        branch: ":___SEE_IF_WE_CAN_PUSH___"
    }).then(function(result) {
        // We should never get here but return 'pushable' just in case remote branch existed.
        return true;
    }, function(err) {
        if (/Permission to [^\s]* denied/.test(err.message)) {
            return false;
        }
        if (/unable to push to unqualified destination/.test(err.message)) {
            return true;
        }
        throw err;
    });
}

Interface.prototype.commit = function(message, options) {
    var self = this;
    var deferred = Q.defer();
    self.isRepository(function(err, isRepository) {
        if (err) return deferred.reject(err);
        if (!isRepository) {
            return deferred.reject(new Error("Not a git repository: " + self.path));
        }
        function commit(err) {
            if (err) return deferred.reject(err);
            return self.callGit([
                "commit",
                "-m", "'" + message + "'"
            ], options, function(err, result) {
                if (err) return deferred.reject(err);
                if (!/\d* files? changed,/.test(result)) {
                    return deferred.reject(new Error("Error committing: " + result));
                }
                return deferred.resolve();
            });
        }
        if (options.add) {
            return self.callGit([
                "add",
                "."
            ], options, commit);
        } else {
            return commit(null);
        }
    });
    return deferred.promise;
}

Interface.prototype.callGit = function(procArgs, options, callback) {
    var self = this;

    options = options || {};
    if (typeof options.verbose === "undefined") {
        options.verbose = self.options.verbose;
    }
    
    if (options.verbose) TERM.stdout.writenl("\0cyan(Running: git " + procArgs.join(" ") + " (cwd: " + (options.cwd || self.path) + ")\0)");

    var env = UTIL.copy(process.env);
    env.GIT_SSH = PATH.join(__dirname, "git-ssh.sh");

    if (!options.verbose || options.mode === "exec") {

        EXEC("git " + procArgs.join(" "), {
            cwd: options.cwd || self.path,
            env: env
        }, function(error, stdout, stderr) {
            if (error) {
                return callback(new Error("Git error: " + stdout + " " + stderr + " (git " + procArgs.join(" ") + " (cwd: " + (options.cwd || self.path) + ")"));
            }
            if (/^fatal:/.test(stdout) || /^fatal:/.test(stderr)) {
                return callback(new Error("Git error: " + stdout + " " + stderr));
            }
            if (options.verbose) {
                TERM.stdout.write(stdout);
            }
            return callback(null, stdout);
        });

    } else {

        var proc = SPAWN("git", procArgs, {
            cwd: options.cwd || self.path,
            env: env
        });
        var buffer = "";

        proc.on("error", function(err) {
            return callback(err);
        });
        
        proc.stdout.on("data", function(data) {
            if (options.verbose) {
                TERM.stdout.write(data.toString());
            }
            buffer += data.toString();
        });
        proc.stderr.on("data", function(data) {
            if (options.verbose) {
                TERM.stderr.write(data.toString());
            }
            buffer += data.toString();
        });
        proc.on("exit", function(code) {
            // NOTE: Sometimes `git describe --tags <non-existent-rev>` exits with code 128 (git did not exit cleanly)
            //       instead of code 1 and buffer `fatal: No names found, cannot describe anything.`.
            // @issue https://github.com/sourcemint/sm/issues/3
            if (code !== 0) {
                if (!buffer) buffer = "(exit code " + code + ")";
                return callback(new Error("Git error: " + buffer + " (git " + procArgs.join(" ") + " (cwd: " + (options.cwd || self.path) + ")"));
            }
            if (/^fatal:/.test(buffer)) {
                return callback(new Error("Git error: " + buffer));
            }
            return callback(null, buffer);
        });
    }
}




/*
var UTIL = require("./util");
var SEMVER = require("./semver");
// Copyright 2009 Christoph Dorn
var Git = exports.Git = function(path) {
    if (!(this instanceof exports.Git))
        return new exports.Git(path);
    this.cache = {};
    this.path = path;
    this.checkInitialized();
}

Git.prototype.checkInitialized = function() {
    this.rootPath = null;
    if (PATH.existsSync(this.path)) {
        try {
            var result = this.runCommand('git rev-parse --git-dir');
            if(result && result.substr(0,27)!="fatal: Not a git repository") {
                this.rootPath = PATH.dirname(result);
                if(this.rootPath.valueOf()==".") {
                    this.rootPath = this.path.join(this.rootPath);
                }
            }
        } catch(e) {}
    }
    return this.initialized();
}

Git.prototype.initialized = function() {
    return (this.rootPath!==null);
}

Git.prototype.getType = function() {
    return "git";
}

Git.prototype.getPath = function() {
    return this.path;
}

Git.prototype.getRootPath = function() {
    if(!this.initialized()) return false;
    return this.rootPath;
}

Git.prototype.getPathPrefix = function() {
    var path = this.getRootPath().join(".").relative(this.getPath()).valueOf();
    if(path.substr(path.length-1,1)=="/") {
        path = path.substr(0, path.length-1);
    }
    return FILE.Path(path);
}

Git.prototype.init = function() {
    if(this.initialized()) {
        throw new GitError("Repository already initialized at: " + this.getPath());
    }
    this.getPath().mkdirs();
    this.runCommand("git init");
    if(!this.checkInitialized()) {
        throw new GitError("Error initializing repository at: " + this.getPath());
    }
}

Git.prototype.runCommand = function(command) {

    command = "cd " + this.path.valueOf() + "; " + command;
    
    var process = OS.popen(command);
    var result = process.communicate();
    var stdout = result.stdout.read();
    var stderr = result.stderr.read();
    if (result.status === 0 || (result.status==1 && !stderr)) {
        return UTIL.trim(stdout);
    }
    throw new GitError("Error running command (status: "+result.status+") '"+command+"' : "+stderr);
}


Git.prototype.getLatestVersion = function(majorVersion, path) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand('git tag -l "' + ((path)?path+"/":"") + 'v*"');
    if(!result) {
        return false;
    }
    var versions = UTIL.map(result.split("\n"), function(version) {
        if(path) {
            return UTIL.trim(version).substr(path.length+2);
        } else {
            return UTIL.trim(version).substr(1);
        }
    });
    return SEMVER.latestForMajor(versions, majorVersion);
}


Git.prototype.getLatestRevisionForBranch = function(branch) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }

    var result = this.runCommand('git log --no-color --pretty=format:"%H" -n 1 ' + branch);
    if(!result) {
        return false;
    }
    return UTIL.trim(result);
}

Git.prototype.getFileForRef = function(revision, path) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var path = this.getPathPrefix().join(path);
    if(path.substr(0,1)=="/") path = path.substr(1);
    var result = this.runCommand('git show ' + revision + ':' + path);
    if(!result) {
        return false;
    }
    return result;
}

Git.prototype.getRepositories = function() {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    if(this.cache.repositories) {
        return this.cache.repositories;
    }
    var result = this.runCommand('git remote show');
    if(!result) {
        return false;
    }
    var remotes = UTIL.trim(result).split("\n"),
        self = this,
        repositories = [];
    remotes.forEach(function(name) {
        result = self.runCommand('git remote show -n ' + name);
        repositories.push(new RegExp("^. remote " + name + "\n ( Fetch)? URL: ([^\n]*)\n").exec(result)[2]);
    });
    this.cache.repositories = repositories;
    return repositories;
}

Git.prototype.add = function(path) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git add " + OS.enquote(path));
    if(result!="") {
        throw new GitError("Error adding file at path: " + path);
    }
    return true;
}

Git.prototype.commit = function(message) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git commit -m " + OS.enquote(message));
    if(!result) {
        throw new GitError("Error comitting");
    }
    if(!/\d* files changed, \d* insertions\(\+\), \d* deletions\(-\)/g.test(result)) {
        throw new GitError("Error comitting: " + result);
    }
    // TODO: Parse result info
    return true;
}

Git.prototype.remoteAdd = function(name, url) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git remote add " + OS.enquote(name) + " " + OS.enquote(url));
    if(result!="") {
        throw new GitError("Error adding remote");
    }
    return true;
}

Git.prototype.push = function(name, branch) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git push " + OS.enquote(name) + " " + OS.enquote(branch));
    if(result!="") {
        throw new GitError("Error pusing");
    }
    return true;
}

Git.prototype.clone = function(url) {
    if(this.initialized()) {
        throw new GitError("Repository already initialized at path: " + this.getPath());
    }
    var result = this.runCommand("git clone " + OS.enquote(url) + " .");
    if(!/^Initialized empty Git repository/.test(result)) {
        throw new GitError("Error cloning repository from: " + url);
    }
    if(!this.checkInitialized()) {
        throw new GitError("Error verifying cloned repository at: " + this.getPath());
    }
    return true;
}


Git.prototype.branch = function(name, options) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    options = options || {};
    if(options.track) {
        var result = this.runCommand("git branch --track " + options.track + " " + name);
        var parts = name.split("/");
        if(result!="Branch "+options.track+" set up to track remote branch "+parts[1]+" from "+parts[0]+".") {
            throw new GitError("Error creating branch: " + result);
        }
        return true;
    } else {
        throw new GitError("NYI");
    }
}

Git.prototype.checkout = function(name) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git checkout " + name);
    if(result) {
        throw new GitError("Error checking out branch: " + result);
    }
    return true;
}

Git.prototype.getActiveBranch = function() {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git branch"),
        m;
    if(!result) {
        throw new GitError("Error listing branches");
    } else
    if(!(m = result.match(/\n?\*\s(\w*)\n?/))) {
        throw new GitError("Error parsing active branch");
    }
    return m[1];
}

Git.prototype.getBranches = function(remoteName) {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git branch" + ((remoteName)?" -r":""));
    if(!result) {
        throw new GitError("Error listing branches");
    }
    var branches = [],
        m;
    result.split("\n").forEach(function(line) {
        if(remoteName) {
            if(m = line.match(/^\s*([^\/]*)\/(\w*)$/)) {
                if(m[1]==remoteName) {
                    branches.push(m[2]);
                }
            }
        } else {
            if(m = line.match(/^\*\s(\w*)$/)) {
                branches.push(m[1]);
            }
        }
    });
    return branches;
}


Git.prototype.getStatus = function() {
    if(!this.initialized()) {
        throw new GitError("Not initialized!");
    }
    var result = this.runCommand("git status"),
        m;
    if(!result) {
        throw new GitError("Error listing status");
    }
    var info = {
            "ahead": false,
            "dirty": true
        },
        lines = result.split("\n"),
        index = 0;

    if(m = lines[index].match(/^# On branch (.*)$/)) {
        info.branch = m[1];
    }
    index++;

    if(m = lines[index].match(/^# Your branch is ahead of /)) {
        info.ahead = true;
        index += 2;
    }

    if(m = lines[index].match(/^nothing to commit \(working directory clean\)$/)) {
        info.dirty = false;
    }
    
    return info;
}



var GitError = exports.GitError = function(message) {
    this.name = "GitError";
    this.message = message;

    // this lets us get a stack trace in Rhino
    if (typeof Packages !== "undefined")
        this.rhinoException = Packages.org.mozilla.javascript.JavaScriptException(this, null, 0);
}
GitError.prototype = new Error();
*/
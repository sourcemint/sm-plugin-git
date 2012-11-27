
const PATH = require("path");
const FS = require("fs");
const GIT = require("./lib/git");
const EVENTS = require("events");
const CRYPTO = require("crypto");


exports.for = function(API, plugin) {


	// TODO: As we initialize here we do a fetch/pull and then call `callback`.
	//		Call fetch+pull on cache if exists
	//		Call fetch on package if exists (ideally fetch from cache instead of online).


	function fetchIfApplicable(path, options) {
	    var git = GIT.interfaceForPath(API, path, {
	        verbose: options.debug
	    });
	    // TODO: Don't call status here. Only get `status.tracking`, `status.noremote`, `status.branch` and `status.rev`.
	    return git.status().then(function(status) {
	        if (status.type !== "git") return false;
	        if (!options.now) return status;

	        return API.Q.call(function() {
	            if (status.tracking) {
	                return git.fetch("origin", {
	                    verbose: options.verbose
	                }).then(function() {
	                	if (!options.pull) return;
		                return git.pull("origin", status.branch, {
		                    verbose: options.verbose
		                }).fail(function(err) {
		                	if (/fatal: Couldn't find remote ref master/.test(err.message)) {
		                		// This happens when remote git repo has not commits.
		                		return;
		                	}
		                	throw err;
		                });
	                });
	            } else if (status.noremote !== true) {
	                // TODO: `status.branch` should not be set if `status.branch === status.rev`.
	                if (status.branch !== status.rev) {
	                    return git.fetch(["origin", status.branch], {
	                        verbose: options.verbose
	                    });
	                }
	            }
	        }).then(function() {
	        	return false;
	        });
		});
	}

	function getStatus(path, options) {
		return fetchIfApplicable(path, options).then(function(status) {

			var git = GIT.interfaceForPath(API, path, {
		        verbose: options.debug
		    });

		    return git.isRepository().then(function(isRepository) {
		    	if (!isRepository) return false;

	            // TODO: Reorganize status info and provide complete local status to determine if ANYTHING has changed compared to 'origin'.
	            //       This should also include extra remotes.

		        var done = API.Q.ref();

		        if (!status) {
		            done = API.Q.when(done, function() {
		                return git.status().then(function(newStatus) {
		                    status = newStatus;
		                });
		            });
		        }

		        return API.Q.when(done, function() {
		            return git.remotes().then(function(remotes) {
		                if (remotes["origin"]) {
		                    status.remoteUri = remotes["origin"]["push-url"];
		                    if (/^[^@]*@[^:]*:/.test(status.remoteUri)) {
		                        status.writable = true;
		                    }
		                }
		            });
		        }).then(function() {
					var summary = {
						raw: status,
						rev: status.rev,
						version: status.tagged,
						selector: (status.branch && status.branch !== status.rev)?status.branch:false,
						versions: status.tags || [],
						dirty: status.dirty,
						writable: status.writable,
						ahead: status.ahead,
						behind: status.behind,
						descriptor: false
					};
					var deferred = API.Q.defer();

					// TODO: Load all package descriptors with the various overlays.
					PATH.exists(PATH.join(path, "package.json"), function(exists) {
						if (!exists) return deferred.resolve(summary);
						FS.readFile(PATH.join(path, "package.json"), function(err, data) {
							try {
								summary.descriptor = JSON.parse(data);
							} catch(err) {
								console.error("Error parsing JSON from: " + PATH.join(path, "package.json"));
							}
							// NOTE: `summary.version` holds the tagged version if set and falls back to
							//		 version declared in package descriptor if not set. To reference
							//		 exact package always use `summary.rev` as it always more narrow than
							//		 `summary.version`.
							if (!summary.version && summary.descriptor.version) {
								summary.version = summary.descriptor.version;
							}
							return deferred.resolve(summary);
						});
					});

		            return deferred.promise;
		        });
	        });
		});
	}

    plugin.resolveLocator = function(locator, options) {
        var self = this;

        if (typeof locator.getLocation === "undefined") {
	        // TODO: Parse `locator.descriptor.pointer` and set `locator.getLocation` function.    	
        }

        if (!locator.selector || locator.version) return self.API.Q.resolve();

        // See if `locator.selector` is a 'version'.

        function checkPath(path, pull, callback) {
        	var opts = API.UTIL.copy(options);
        	if (pull) opts.pull = true;
			return fetchIfApplicable(path, opts).then(function(status) {
	            var git = GIT.interfaceForPath(API, path, {
			        verbose: options.debug
			    });
				return git.isRepository().then(function(isRepository) {
					if (!isRepository) return callback(null);
					return git.callGit([
	                    "rev-parse",
	                    locator.selector
	                ]).then(function(result) {
	                    locator.rev = result.replace(/\n$/, "");
	                    if (locator.rev.substring(0, locator.selector.length) === locator.selector) {
	                    	locator.selector = false;
	                    }
						return git.isTagged(options).then(function(isTagged) {
                            if (isTagged) {
                                locator.version = isTagged;
                            }
		                	return callback(null);
                        });
	                }, function() {
	                	// 'selector' not found as branch or ref in repo.
	                	return callback(null);
	                });
				});
			}).fail(callback);
        }

        var deferred = API.Q.defer();

        checkPath(plugin.node.getCachePath("external", locator.getLocation("git-write") || locator.getLocation("git-read")), true, function(err) {
        	if (err) return deferred.reject(err);

			if (locator.rev || !plugin.node.exists) return deferred.resolve();

	        checkPath(plugin.node.path, false, function(err) {
	        	if (err) return deferred.reject(err);
	        	return deferred.resolve();
	        });
        });

        return deferred.promise;
    }

	plugin.status = function(options) {
		if (!plugin.node.exists) return API.Q.resolve(false);
		return getStatus(plugin.node.path, options);
	}

	plugin.descriptorForSelector = function(locator, selector, options) {
		function loadDescriptorAt(path, selector) {
			selector = selector || "master";
			var git = GIT.interfaceForPath(API, path, {
		        verbose: options.debug
		    });
		    return git.isRepository().then(function(isRepository) {
		    	if (!isRepository) return false;
			    return git.show(selector, "package.json").then(function(result) {
			    	if (!result) return false;
			    	try {
				    	var info = {
				    		descriptor: JSON.parse(result)
				    	};
						return git.callGit([
		                    "rev-parse",
		                    selector
		                ]).then(function(result) {
		                    info.rev = result.replace(/\n$/, "");
							return git.isTagged(options).then(function(isTagged) {
	                            if (isTagged) {
	                                info.version = isTagged;
	                            }
			                	return info;
	                        });
		                });
			    	} catch(err) {
			    		throw new Error("Error parsing 'package.json' from '" + path + "' at '" + selector + "'");
			    	}
			    });
			});
		}
		return loadDescriptorAt(plugin.node.getCachePath("external", locator.getLocation("git-write") || locator.getLocation("git-read")), selector).then(function(descriptor) {
			if (descriptor) return descriptor;
	        return loadDescriptorAt(plugin.node.path, selector);
		});
	}


	plugin.latest = function(options) {
		var self = this;

		var uri = self.node.summary.declaredLocator.getLocation("git-write") || self.node.summary.declaredLocator.getLocation("git-read");

		if (!uri) return API.Q.resolve(false);

		return plugin.getLatestInfoCache(uri, function(req, callback) {
			if (req.method === "HEAD") {
				return callback(null, {
					statusCode: 200,
					headers: {
						"etag": Date.now()
					}
				});
			}
			if (req.method === "GET") {

				var cachePath = plugin.node.getCachePath("external", uri);
				var deferred = API.Q.defer();
				PATH.exists(cachePath, function(cacheExists) {
					PATH.exists(PATH.join(plugin.node.path, ".git"), function(workingHasRepo) {
						try {
							// Fetch latest only if
							if (!(
								// we know where to fetch from
								uri &&
								(
									// repo exists in cache or
									cacheExists
									||
									// working dir has repo
									workingHasRepo
								)
							)) return deferred.resolve(false);

			                if (options.debug) console.log("Downloading '" + uri + "' to '" + cachePath + "'.");

			                var git = GIT.interfaceForPath(API, cachePath, {
			                    verbose: options.debug
			                });

			                return git.isRepository().then(function(isRepository) {
			                    if (isRepository) {

			                        function fetch() {
			                            if (options.debug) console.log("Fetch from '" + uri + "'.");

			                            // TODO: Based on `options.now` don't fetch.
			                            // TODO: Based on `options.time` track if called multiple times and only proceed once.
			                            return git.fetch("origin").then(function(code) {
			                                // TODO: More finer grained update checking. If branch has not changed report 304.
			                                status = code;
			                            }).fail(function(err) {
			                                TERM.stdout.writenl("\0red(" + err.message + "\0)");
			                                TERM.stdout.writenl("\0red([sm] TODO: If remote origin URL is a read URL switch to write URL and try again. If still fails switch back to read URL.\0)");
			                                throw err;
			                            });
			                        }

			                        if (
			                        	typeof self.node.summary.declaredLocator.rev !== "undefined" ||
			                        	self.node.summary.declaredLocator.version !== "undefined"
			                        ) {
			                            // We have a ref or version in a local or fetched remote branch or a tag.
			                            // We don't need to fetch even if options.now is set as our ref/version already exists locally.
// TODO: Fetch anyway as we want the *latest online info*.
			                            status = 304;
			                            return;
			                        }

			                        if (typeof self.node.summary.declaredLocator.selector !== "undefined") {
			                            // Not found. `self.node.summary.declaredLocator.selector` is an unfetched ref or tag or a branch name.
			                            // Check if `self.node.summary.declaredLocator.selector` is a fetched remote branch name (locally we only have the 'master' branch).
			                            var deferred = API.Q.defer();
			                            PATH.exists(PATH.join(cachePath, ".git/refs/remotes/origin", self.node.summary.declaredLocator.selector), function(exists) {
			                                if (exists) {
			                                    // `fromLocator.version` is a fetched remote branch name. We fetch latest only if `options.now` is set.
			                                    if (options.now) {
			                                        return fetch().then(deferred.resolve, deferred.reject);
			                                    }
			                                    status = 304;
			                                    return deferred.resolve();
			                                }
			                                // We need to fetch as `fromLocator.version` is not found to me a fetched remote branch name.
			                                return fetch().then(deferred.resolve, deferred.reject);
			                            });
			                            return deferred.promise;
			                        }

									// We don't have a rev or selector so we need to fetch latest.
									return fetch();


/*
			                        // If we have a version set only fetch if not found locally.
			                        if (typeof self.node.summary.declaredLocator.version !== "undefined") {
				                        return git.callGit([
				                            "rev-parse",
				                            self.node.summary.declaredLocator.version
				                        ]).then(function(result) {
				                            // `self.node.summary.declaredLocator.version` is a ref in a local or fetched remote branch or a tag.
				                            // We don't need to fetch even if options.now is set as our ref already exists locally.
				                            status = 304;
				                            return;
				                        }, function() {
				                            // Not found. `self.node.summary.declaredLocator.version` is an unfetched ref or tag or a branch name.
				                            // Check if `fromLocator.version` is a fetched remote branch name (locally we only have the 'master' branch).
				                            var deferred = API.Q.defer();
				                            PATH.exists(PATH.join(cachePath, ".git/refs/remotes/origin", fromLocator.version), function(exists) {
				                                if (exists) {
				                                    // `fromLocator.version` is a fetched remote branch name. We fetch latest only if `options.now` is set.
				                                    if (options.now) {
				                                        return fetch().then(deferred.resolve, deferred.reject);
				                                    }
				                                    status = 304;
				                                    return deferred.resolve();
				                                }
				                                // We need to fetch as `fromLocator.version` is not found to me a fetched remote branch name.
				                                return fetch().then(deferred.resolve, deferred.reject);
				                            });
				                            return deferred.promise;
				                        });
									} else {
										// We don't have a version so we need to fetch latest.
										return fetch();
									}
*/
			                    } else {

			                        if (cacheExists) {
			                            FS.rmdirSync(cachePath);
			                        }

			                        if (options.debug) console.log("Clone '" + uri + "'.");

			                        return git.clone(uri, {
			                            // Always show clone progress as this can take a while.
			                            verbose: true
			                        }).then(function() {

			                            // TODO: Write success file. If success file not present next time we access, re-clone.

			                            // See if we can push. If not we set remote origin url to read.
			                            if (self.node.summary.declaredLocator.getLocation("git-read")) {
			                                return git.canPush().then(function(canPush) {
			                                    if (!canPush) {
			                                        // We cannot push so we need to change the URI.
			                                        return git.setRemote("origin", stripRevFromUri(self.node.summary.declaredLocator.getLocation("git-read")));
			                                    }
			                                });
			                            }
			                        }).then(function() {
			                            status = 200;
			                        });
			                    }
			                }).then(function() {

			                	// TODO: Keep latest status cached in local external cache at `cachePath + "-latest"` and
			                	//		 use 'ttl' to determine if we need to fetch.

								return getStatus(cachePath, options);

			                }).then(deferred.resolve, deferred.reject);
						} catch(err) {
							return deferred.reject(err);
						}
					});
				});

				return API.Q.when(deferred.promise, function(status) {
					// TODO: Use a API.HELPER to generate result.
					var response = new EVENTS.EventEmitter();
					response.statusCode = 200;
					var body = JSON.stringify(status, null, 4);
					var etag = CRYPTO.createHash("sha1");
					etag.update(body);
					response.headers = {
						"content-length": body.length,
						"etag": etag.digest("hex")
					};
					callback(null, response);
					response.emit("data", body);
					response.emit("end");
				}).fail(callback);
			}
			throw new Error("Method '" + req.method + "' not implemented!");

		}, options).then(function(response) {

			return JSON.parse(response.body.toString());
		});
	}
}

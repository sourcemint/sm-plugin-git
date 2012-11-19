
const PATH = require("path");
const FS = require("fs");
const GIT = require("./lib/git");


exports.for = function(API, plugin) {

	plugin.status = function(options) {
		if (!plugin.node.exists) return API.Q.resolve(false);
		var deferred = API.Q.defer();
		PATH.exists(PATH.join(plugin.node.path, ".git"), function(exists) {

			if (!exists) return deferred.resolve(false);

		    var git = GIT.interfaceForPath(API, plugin.node.path, {
		        verbose: options.debug
		    });

            // TODO: Reorganize status info and provide complete local status to determine if ANYTHING has changed compared to 'origin'.
            //       This should also include extra remotes.

		    return git.status().then(function(status) {
		        if (status.type !== "git") return false;

		        var done = API.Q.ref();

		        if (options.now) {
                    // TODO: Fetch latest in cache path and sync to here instead of fetching latest here.
		            done = Q.when(done, function() {
		                if (status.tracking) {
		                    return git.fetch("origin", {
		                        verbose: options.verbose
		                    });
		                } else if (status.noremote !== true) {
		                    // TODO: `status.branch` should not be set if `status.branch === status.rev`.
		                    if (status.branch !== status.rev) {
		                        return git.fetch(["origin", status.branch], {
		                            verbose: options.verbose
		                        });
		                    }
		                }
		            });
		            done = Q.when(done, function() {
		                return git.status().then(function(newStatus) {
		                    status = newStatus;
		                });
		            });
		        }

		        return API.Q.when(done, function() {
		            return git.remotes().then(function(remotes) {
		                if (remotes["origin"]) {
		                    status.remoteUri = remotes["origin"]["push-url"];
		                    var parsedRemoteUri = API.URI_PARSER.parse(remotes["origin"]["push-url"]);
		                    if (parsedRemoteUri.href === parsedRemoteUri.locators["git-write"]) {
		                        status.writable = true;
		                    }
		                }
		            });
		        }).then(function() {
		            return status;
		        });
	        }).then(deferred.resolve, deferred.reject);
		});
		return deferred.promise;
	}

	plugin.latest = function(options) {
		var self = this;
		if (
			!self.node.locator ||
			!self.node.locator.locations ||
			(
				!self.node.locator.locations["git-write"] &&
				!self.node.locator.locations["git-read"]
			)
		) return API.Q.resolve(false);
        function stripRevFromUri(uri) {
            return uri.replace(/#[^#]*$/, "");
        }
		var uri = stripRevFromUri(self.node.locator.locations["git-write"] || self.node.locator.locations["git-read"]);
		var cachePath = plugin.node.getCachePath("external", uri);
		var deferred = API.Q.defer();
		PATH.exists(cachePath, function(cacheExists) {
			PATH.exists(PATH.join(plugin.node.path, ".git"), function(workingHasRepo) {
				try {
					// Fetch latest only if
					if (!(
						// we know where to fetch from
						(self.node.locator.locations["git-write"] || self.node.locator.locations["git-read"]) &&
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

	                        // If we have a version set only fetch if not found locally.
	                        if (typeof self.node.locator.version !== "undefined") {
		                        return git.callGit([
		                            "rev-parse",
		                            self.node.locator.version
		                        ]).then(function(result) {
		                            // `fromLocator.version` is a ref in a local or fetched remote branch or a tag.
		                            // We don't need to fetch even if options.now is set as our ref already exists locally.
		                            status = 304;
		                            return;
		                        }, function() {
		                            // Not found. `fromLocator.version` is an unfetched ref or tag or a branch name.
		                            // Check if `fromLocator.version` is a fetched remote branch name (locally we only have the 'master' branch).
		                            var deferred = Q.defer();
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
	                            if (self.node.locator.locations["git-read"]) {
	                                return git.canPush().then(function(canPush) {
	                                    if (!canPush) {
	                                        // We cannot push so we need to change the URI.
	                                        return git.setRemote("origin", stripRevFromUri(self.node.locator.locations["git-read"]));
	                                    }
	                                });
	                            }
	                        }).then(function() {
	                            status = 200;
	                        });
	                    }
	                }).then(function() {

	console.log("GET git STATUS", self.node.locator);

	console.log("TODO", "GET LATEST FOR SELECTOR");

	                    return {
	                        status: status,
	                        cachePath: cachePath,
	                        locator: {

	                        }
	                    };
	                }).then(deferred.resolve, deferred.reject);
				} catch(err) {
					return deferred.reject(err);
				}
			});
		});
		return deferred.promise;


		// Return LATEST git info (fetch latest in cache and then get info)
		// Respect options.time and options.now
	}

}

/*
 *  Minimal ES2015+ Promise polyfill
 *
 *  Limitations (also see XXX in source):
 *
 *    - Caller must manually call Promise.runQueue() to process pending jobs.
 *    - No Promise subclassing or non-subclass foreign Promises yet.
 *    - Promise.all() and Promise.race() assume a plain array, not iterator.
 *    - Doesn't handle errors from core operations, e.g. out-of-memory or
 *      internal error when queueing/running jobs.  These are implementation
 *      defined for the most part.
 *
 *  This polyfill was originally used to gain a better understanding of the
 *  ES2015 specification algorithms, before implementing Promises natively.
 *
 *  The polyfill uses a Symbol to mark Promise instances, but falls back to
 *  an ordinary (non-enumerable) property if no Symbol support is available.
 *
 *  See also: https://github.com/stefanpenner/es6-promise#readme
 */

(function () {
    if (typeof Promise !== 'undefined') { return; }

    // As far as the specification goes, almost all Promise settling is via
    // concrete resolve/reject functions with mutual protection from being
    // called multiple times.  Sometimes the actual resolve/reject functions
    // are not exposed to calling code, and can safely be omitted which is
    // useful because resolve/reject functions are memory heavy.  These
    // optimizations are enabled by default; set to false to disable.
    var allowOptimization = true;

    // Job queue to simulate ES2015 job queues, linked list, 'next' reference.
    // While ES2015 doesn't guarantee the relative order of jobs in different
    // job queues, within a certain queue strict FIFO is required.  See ES5.1
    // https://www.ecma-international.org/ecma-262/6.0/#sec-jobs-and-job-queues:
    // "The PendingJob records from a single Job Queue are always initiated in
    // FIFO order. This specification does not define the order in which
    // multiple Job Queues are serviced."
    var queueHead = null, queueTail = null;
    function enqueueJob(job) {
        // Avoid inheriting conflicting properties if caller already didn't
        // ensure it.
        Object.setPrototypeOf(job, null);
        compact(job);
        if (queueHead) {
            queueTail.next = job;
            compact(queueTail);
            queueTail = job;
        } else {
            queueHead = job;
            queueTail = job;
        }
    }
    function dequeueJob() {
        var ret = queueHead;
        if (ret) {
            queueHead = ret.next;
            if (!queueHead) {
                queueTail = null;
            }
        }
        return ret;
    }

    // Helper to define/modify properties more compactly.
    function def(obj, key, val, attrs) {
        if (attrs === void 0) { attrs = 'wc'; }
        Object.defineProperty(obj, key, {
            value: val,
            writable: attrs.indexOf('w') >= 0,
            enumerable: attrs.indexOf('e') >= 0,
            configurable: attrs.indexOf('c') >= 0
        });
    }

    // Helper for Duktape specific object compaction.
    var compact = (typeof Duktape === 'object' && Duktape.compact) ||
                  function (v) { return v; };

    // Promise detection (plain or subclassed Promise), in spec has
    // [[PromiseState]] internal slot which isn't affected by Proxy
    // behaviors etc.
    var haveSymbols = (typeof Symbol === 'function');
    var promiseMarker = haveSymbols ? Symbol('promise') : '__PromiseInstance__';
    function isPromise(p) {
        return p !== null && typeof p === 'object' && promiseMarker in p;
    }
    function requirePromise(p) {
        if (!isPromise(p)) { throw new TypeError('Promise required'); }
    }

    // Raw fulfill/reject operations, assume resolution processing done.
    // The specification algorithms RejectPromise() and FulfillPromise()
    // assert that the Promise is pending so the initial check in these
    // implementations (p.state !== void 0) is not needed: the resolve/reject
    // function pairs always ensure a Promise is not ultimately settled twice.
    // With some of the "as if" optimizations we rely on these raw operations
    // to protect against multiple attempts to settle the Promise so the checks
    // are actually needed.
    function doFulfill(p, val) {
        if (p.state !== void 0) { return; }  // additional check needed with optimizations
        p.state = true; p.value = val;
        var reactions = p.fulfillReactions;
        delete p.fulfillReactions; delete p.rejectReactions; compact(p);
        reactions.forEach(function (ent) {
            // Conceptually: create a job from the registered reaction.
            // In practice: reuse the reaction object because it is unique,
            // never leaks to calling code, and is never reused.
            ent.value = val;
            enqueueJob(ent);
        });
    }
    function doReject(p, val) {
        if (p.state !== void 0) { return; }  // additional check needed with optimizations
        p.state = false; p.value = val;
        var reactions = p.rejectReactions;
        delete p.fulfillReactions; delete p.rejectReactions; compact(p);
        reactions.forEach(function (ent) {
            // As for doFulfill(), reuse the registered reaction object.
            ent.value = val;
            if (!ent.handler) {
                // Without a .handler, we're dealing with an optimized
                // entry where only .target exists and the resolve/reject
                // behavior is simulated when the entry runs.  However,
                // we need to know whether to simulate resolve or reject
                // at that time, so flag rejection explicitly (resolve
                // requires no flag).
                ent.rejected = true;
            }
            enqueueJob(ent);
        });
    }

    // Create a new resolve/reject pair for a Promise.  Multiple pairs are
    // needed in thenable handling, with all but the most recent pair being
    // neutralized ('alreadyResolved').  Because Promises are resolved only
    // via this resolution process, it shouldn't be possible for the Promise
    // to be settled but check it anyway: it may be useful for e.g. the C API
    // to forcibly resolve/fulfill/reject a Promise regardless of extant
    // resolve/reject functions.
    function createResolutionFunctions(p) {
        // In ES2015 the resolve/reject functions have a shared 'state' object
        // with a [[AlreadyResolved]] slot.  Here we use an in-scope variable.
        var alreadyResolved = false;
        var reject = function (err) {
            if (new.target) { throw new TypeError('reject is not constructable'); }
            if (alreadyResolved) { return; }
            alreadyResolved = true;  // neutralize resolve/reject
            if (p.state !== void 0) { return; }
            doReject(p, err);
        };
        reject.prototype = null;  // drop .prototype object
        var resolve = function (val) {
            if (new.target) { throw new TypeError('resolve is not constructable'); }
            if (alreadyResolved) { return; }
            alreadyResolved = true;  // neutralize resolve/reject
            if (p.state !== void 0) { return; }
            if (val === p) {
                return doReject(p, new TypeError('self resolution'));
            }
            try {
                var then = (val !== null && typeof val === 'object' &&
                            val.then);
                if (typeof then === 'function') {
                    var t = createResolutionFunctions(p);
                    var optimized = allowOptimization;
                    if (optimized) {
                        // XXX: this optimization may not be useful because the
                        // job entry runs usually very quickly, and as part of
                        // running the job, the resolve/reject function must be
                        // created for the then() call.
                        return enqueueJob({
                            thenable: val,
                            then: then,
                            target: p
                        });
                    } else {
                        return enqueueJob({
                            thenable: val,
                            then: then,
                            resolve: t.resolve,
                            reject: t.reject
                        });
                    }
                    // old resolve/reject is neutralized, only new pair is live
                }
                return doFulfill(p, val);
            } catch (e) {
                return doReject(p, e);
            }
        };
        resolve.prototype = null;  // drop .prototype object
        return { resolve: resolve, reject: reject };
    }

    // Job queue simulation.
    function runQueueEntry() {
        // XXX: In optimized cases, creating both resolution functions is
        // not always necessary.  There's also no need for alreadySettled
        // protections for the optimized cases either.
        var job = dequeueJob();
        var tmp;
        if (!job) { return false; }
        if (job.then) {
            // PromiseResolveThenableJob
            if (job.target) {
                tmp = createResolutionFunctions(job.target);
            }
            try {
                if (tmp) {
                    void job.then.call(job.thenable, tmp.resolve, tmp.reject);
                } else {
                    void job.then.call(job.thenable, job.resolve, job.reject);
                }
            } catch (e) {
                if (tmp) {
                    tmp.reject.call(void 0, e);
                } else {
                    job.reject.call(void 0, e);
                }
            }
        } else {
            // PromiseReactionJob
            try {
                if (job.handler === void 0) {
                    // Optimized case where two Promises are tied together
                    // without the need for an actual 'handler'.
                    tmp = createResolutionFunctions(job.target);  // must exist in this case
                    tmp = job.rejected ? tmp.reject : tmp.resolve;
                    tmp.call(void 0, job.value);
                    return true;
                } else if (job.handler === 'Identity') {
                    res = job.value;
                } else if (job.handler === 'Thrower') {
                    throw job.value;
                } else {
                    res = job.handler.call(void 0, job.value);
                }
                if (job.target) {
                    createResolutionFunctions(job.target).resolve.call(void 0, res);
                } else {
                    job.resolve.call(void 0, res);
                }
            } catch (e) {
                if (job.target) {
                    createResolutionFunctions(job.target).reject.call(void 0, e);
                } else {
                    job.reject.call(void 0, e);
                }
            }
        }
        return true;
    }

    // %Promise% constructor.
    var cons = function Promise(executor) {
        if (!new.target) {
            throw new TypeError('Promise must be called as a constructor');
        }
        if (typeof executor !== 'function') {
            throw new TypeError('executor must be callable');
        }
        var _this = this;
        def(this, promiseMarker, true, '');
        def(this, 'state', void 0);   // undefined (pending), true/false
        def(this, 'value', void 0);
        def(this, 'fulfillReactions', []);
        def(this, 'rejectReactions', []);
        compact(this);
        var t = createResolutionFunctions(this);
        try {
            void executor(t.resolve, t.reject);
        } catch (e) {
            t.reject(e);
        }
    };
    var proto = cons.prototype;
    def(cons, 'prototype', proto, '');

    // %Promise%.resolve().
    // XXX: direct handling
    function resolve(val) {
        if (isPromise(val) && val.constructor === this) { return val; }
        return new Promise(function (resolve, reject) { resolve(val); });
    }

    // %Promise%.reject()
    // XXX: direct handling
    function reject(val) {
        return new Promise(function (resolve, reject) { reject(val); });
    }

    // %Promise%.all().
    function all(list) {
        if (!Array.isArray(list)) {
            throw new TypeError('non-array all() argument not supported');
        }
        var resolveFn, rejectFn;
        var p = new Promise(function (resolve, reject) {
            resolveFn = resolve; rejectFn = reject;
        });
        var values = [];
        var index = 0;
        var remaining = 1;  // remaining intentionally 1, not 0
        list.forEach(function (x) {  // XXX: no iterator support
            var t = Promise.resolve(x);
            var f = function promiseAllElement(val) {
                var F = promiseAllElement;
                if (F.alreadyCalled) { return; }
                F.alreadyCalled = true;
                values[F.index] = val;
                if (--remaining === 0) {
                    resolveFn.call(void 0, values);
                }
            };
            // In ES2015 the functions would reference a shared state object
            // explicitly.  Here the conceptual state is in scope.
            f.index = index++;
            remaining++;
            t.then(f, rejectFn);
        });
        if (--remaining === 0) {
            resolveFn.call(void 0, values);
        }
        return p;
    }

    // %Promise%.race().
    function race(list) {
        if (!Array.isArray(list)) {
            throw new TypeError('non-array race() argument not supported');
        }
        var resolveFn, rejectFn;
        var p = new Promise(function (resolve, reject) {
            resolveFn = resolve; rejectFn = reject;
        });
        list.forEach(function (x) {  // XXX: no iterator support
            var t = Promise.resolve(x);
            var func = t.then;
            var optimized = (func === then) && allowOptimization;
            if (optimized) {
                // If the .then() of the Promise.resolve() is the original
                // built-in implementation, we don't need to queue the actual
                // resolve and reject functions explicitly because (1) the
                // functions don't leak and can't be called by anyone else,
                // and (2) the onFulfilled/onRejected functions would just
                // directly forward the result from 't' to 'p'.
                optimizedThen(t, p);
            } else {
                // Generic case, the result Promise of .then() is ignored.
                void func.call(t, resolveFn, rejectFn);
            }
        });
        return p;
    }

    // %PromisePrototype%.then(), also used for .catch().
    function then(onFulfilled, onRejected) {
        // No subclassing support here now, no NewPromiseCapability() handling.
        requirePromise(this);
        var resolveFn, rejectFn;
        var p = new Promise(function (resolve, reject) {
            resolveFn = resolve; rejectFn = reject;
        });
        var optimized = allowOptimization;
        if (typeof onFulfilled !== 'function') { onFulfilled = 'Identity'; }
        if (typeof onRejected !== 'function') { onRejected = 'Thrower'; }
        if (this.state === void 0) {  // pending
            if (optimized) {
                this.fulfillReactions.push({
                    handler: onFulfilled,
                    target: p
                });
                this.rejectReactions.push({
                    handler: onRejected,
                    target: p
                });
            } else {
                this.fulfillReactions.push({
                    handler: onFulfilled,
                    resolve: resolveFn,
                    reject: rejectFn
                });
                this.rejectReactions.push({
                    handler: onRejected,
                    resolve: resolveFn,
                    reject: rejectFn
                });
            }
        } else if (this.state) {  // fulfilled
            if (optimized) {
                enqueueJob({
                    handler: onFulfilled,
                    target: p,
                    value: this.value
                });
            } else {
                enqueueJob({
                    handler: onFulfilled,
                    resolve: resolveFn,
                    reject: rejectFn,
                    value: this.value
                });
            }
        } else {  // rejected
            if (optimized) {
                enqueueJob({
                    handler: onRejected,
                    target: p,
                    value: this.value
                });
            } else {
                enqueueJob({
                    handler: onRejected,
                    resolve: resolveFn,
                    reject: rejectFn,
                    value: this.value
                });
            }
        }
        return p;
    }

    // Optimized .then() where a specific source Promise just forwards its
    // result to a target Promise unless its already settled.
    function optimizedThen(source, target) {
        if (source.state === void 0) {  // pending
            source.fulfillReactions.push({
                target: target
            });
            source.rejectReactions.push({
                target: target
            });
        } else if (source.state) {  // fulfilled
            enqueueJob({
                target: target,
                value: source.value
            });
        } else {  // rejected
            enqueueJob({
                target: target,
                value: source.value,
                rejected: true
            });
        }
    }

    // %PromisePrototype%.catch.
    var _catch = function (onRejected) {
        return this.then.call(this, void 0, onRejected);
    };
    def(_catch, 'name', 'catch', 'c');

    // %Promise%.try(), https://github.com/tc39/proposal-promise-try,
    // simple polyfill-style implementation.
    var _try = function (func) {
        // XXX: check 'this' for callability, or Promise / subclass.
        return new this(function (resolve, reject) { resolve(func()); });
    };
    def(_try, 'name', 'try', 'c');

    // Define visible objects and properties.
    (function () {
        def(this, 'Promise', cons);
        def(cons, 'resolve', resolve);
        def(cons, 'reject', reject);
        def(cons, 'all', all);
        def(cons, 'race', race);
        def(cons, 'try', _try);
        def(proto, 'then', then);
        def(proto, 'catch', _catch);
        if (haveSymbols) {
            def(proto, Symbol.toStringTag, 'Promise', 'c');
        }

        // Custom API to drive the "job queue".
        def(cons, 'runQueue', function _runQueueUntilEmpty() {
            while (runQueueEntry()) {}
        });

        compact(this); compact(cons); compact(proto);
    }());
}());

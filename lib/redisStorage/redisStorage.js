const Storage = require('../storage');
const Redis = require('./redisClient');
const Utils = require ('../utils');
const Promise = require('bluebird');

class RedisStorage extends Storage {

    constructor(config, logger = undefined) {
        config = config || {};
        config['instances'] = config['instances'] || [{ host: 'localhost', port: '6379', db: 0 }];
        config['masterIndex'] = config['masterIndex'] || 0;
        config['reconnectIntervalSeconds'] = config['reconnectIntervalSeconds'] || 1;
        config['taskIntervalSeconds'] = config['taskIntervalSeconds'] || 30;
        super(config, logger);
        this.config = config;

        let instancesConfig = JSON.parse(JSON.stringify(this.config['instances']));
        let masterConfig = instancesConfig.splice(this.config['masterIndex'], 1)[0];
        this._mainRedisClient = new Redis(masterConfig, this.config['taskIntervalSeconds'], logger);
        this._redisClients = instancesConfig.map(inst => {
            return new Redis(inst, this.config['taskIntervalSeconds'], logger);
        });
        this._storageSettings = {
            retryScheduleLockMilliseconds : 300
        };
        this._listeningToClients = false;
        this._validate();
    }

    connect() {
        this.logger.debug('connecting..');
        this._setupListeners();
        let connect = Promise.all(this._clients.map(r =>  {
            return r.connected ? Promise.resolve() : r.connect();
        })).then(() => {
          this._online = true;
          this.emit('online');
        });
        return connect;
    }

    assignTask(taskData, intervalSeconds = undefined) {
        let lock;
        let schedule = this._assertConnected().then(() => {
            return this._lockSchedule(taskData['id']);
        }).then(scheduleLock => {
            lock = scheduleLock;
            return this._isScheduledUpdate(taskData['id'], taskData['data'], intervalSeconds);
        }).then(isScheduled => {
            let isNewTask;
            if (!isScheduled) {
                // resolves with true
                isNewTask = this._schedule(taskData['id'], taskData['data'], taskData['startOn'], intervalSeconds);
            } else {
                isNewTask = Promise.resolve(false);
            }
            return Promise.all([isNewTask, isScheduled === 2]);
        }).catch(err => {
            lock && this._unlockSchedule(lock);
            return Promise.reject(err);
        }).then(res => {
            return Promise.all([...res, this._unlockSchedule(lock)]);
        }).then(([isNewTask, unCanceledAndUpdated]) => {
            lock = null;
            return isNewTask || unCanceledAndUpdated;
        }).catch(err => {
            this.logger.error(`failed to assign task err: ${err}`);
            return Promise.reject(err);
        });

        return schedule;
    }

    removeTask(taskId) {
        let remove = this._assertConnected().then(() => {
            return this._isScheduledCancel(taskId);
        });
        return remove;
    }

    pullTask() {
        return this._someClientSerial('pullTask');
    }

    tryLock(lockBy) {
        return this._mainRedisClient.tryLock(lockBy);
    }

    unlock(lock) {
        return this._mainRedisClient.unlock(lock);
    }

    tryAutoLock(lockId, autoReleaseSeconds) {
        return this._mainRedisClient.tryAutoLock(lockId, autoReleaseSeconds);
    }

    clearAllTasks() {
        let clearAll = Promise.all(this._onlineClients.map(c => c.clearAllTasks())).then(res => {
            return Promise.resolve(res.reduce((a, b) => a + b, 0));
        });
        return clearAll;
    }

    peekTask(taskId) {
        return this._someClientParallel('peekTask', taskId);
    }

    queueSize() {
        let queueSizes = Promise.all(this._clients.map(c => c.queueSize())).then(sizes => {
            return sizes.reduce((acc, cur) => acc + cur, 0);
        });
        return queueSizes;
    }

    taskSize() {
        let taskSizes = Promise.all(this._clients.map(c => c.taskSize())).then(sizes => {
            return sizes.reduce((acc, cur) => acc + cur, 0);
        });
        return taskSizes;
    }

    get online() {
        return !!this._online;
    }

    _settings(path) {
        return Utils.objGet(this._storageSettings, path);
    }

    // Check if the task exists in any of the clients, if yes then cancel it.
    // return 1 if task was canceled.
    _isScheduledCancel(taskId) {
        return this._someClientParallel('isScheduledCancel', taskId);
    }

    // Check if the task exists in any of the clients, if yes then update it and un cancel if needed.
    // Return 1 if task exists and was updated and 2 if task was canceled and updated.
    _isScheduledUpdate(taskId, data, intervalSeconds = undefined) {
        return this._someClientParallel('isScheduledUpdate', taskId, data, intervalSeconds);
    }

    _lockSchedule(taskId) {
        let autoReleaseSeconds = this._mainRedisClient.settings('scheduleLock/autoReleaseSeconds');
        let endTime = Date.now() + ((autoReleaseSeconds + 1) * 1000);
        let _scheduleTryLock = () => {
            let tryLock = this.tryLock(taskId).then(lock => {
                if (lock) {
                    return Promise.resolve(lock);
                } else if (endTime - Date.now() > 0) {
                    return Utils.delay(this._settings('retryScheduleLockMilliseconds'));
                } else {
                    return Promise.reject(new Error('could not obtain schedule lock'));
                }
            }).then(lock => {
                if (lock) {
                    return Promise.resolve(lock);
                } else {
                    return _scheduleTryLock();
                }
            });
            return tryLock;
        };

        return _scheduleTryLock();
    }

    _unlockSchedule(lock) {
        return this.unlock(lock).then(unlocked => {
            if(!unlocked) {
                // Either timeout passed and lock does not exist or lock was acquired by other
                this.logger.error('tried unlocking a free lock timeout must have passed');
            }
            return Promise.resolve();
        });
    }

    _schedule(id, data, startOn, intervalSeconds = undefined) {
        let clients = this._onlineClients;
        let selectedRedis = clients[0];
        return selectedRedis.schedule(id, data, startOn, intervalSeconds);
    }

    _setupListeners() {
        if (this._listeningToClients) {
            return;
        }
        this._clients.forEach(redis => {
            redis.on('disconnect', this._onDisconnect.bind(this));
        });
        this._listeningToClients = true;
    }

    _onDisconnect(redis) {
        this.emit('disconnect', redis.name);
        if (this._isMaster(redis)) {
            this._markAsOffline();
        }
        this._reconnect(redis);
    }

    _reconnect(redis) {
        let reconnect = redis.connect().then(() => {
            this.emit('reconnect', redis.name);
            if (this._isMaster(redis)) {
                this._markAsOnline();
            }
            return Promise.resolve(true);
        }).catch(e => {
            return Promise.delay(this.config['reconnectIntervalSeconds'] * 1000);
        }).then(connected => {
            if (!connected) {
                return this._reconnect(redis);
            } else {
                return Promise.resolve();
            }
        });

        return reconnect;
    }

    _isMaster(redis) {
        return this._mainRedisClient.id == redis.id;
    }

    _markAsOnline() {
        this._online = true;
        this.emit('online');
    }

    _markAsOffline() {
        this._online = false;
        this.emit('offline');
    }

    _assertConnected() {
        if (!this.online) {
            return Promise.reject(new Error('redis storage is not connected'));
        } else {
           return Promise.resolve();
        }
    }

    // Call 'method' on all online clients (simultaneously), until one resolves with a result.
    _someClientParallel(method, ...args) {
        let some = new Promise((res, rej) => {
            var clientResult;
            this._assertConnected().then(() => {
                let clientsMethod = this._onlineClients.map(redis => {
                    return redis[method](...args).then((...result) => {
                        if (!!result[0]) {
                            clientResult = result[0];
                            res(clientResult);
                        }
                    }).catch(err => {
                        this.logger.error(`redis client rejected ${method} error: ${err}`)
                    });
                });
                return Promise.all(clientsMethod);
            }).then(() => {
                res(clientResult);
            }).catch(rej);
        });
        return some;
    }

    // Call 'method' on all online clients (one by one), until one resolves with a result.
    _someClientSerial(method, ...args) {
        let clientMethods = this._onlineClients.map(redis => {
            let clientMethod = () => {
                return redis[method](...args).catch(err => {
                    this.logger.error(`redis client rejected ${method} error: ${err}`);
                });
            };
            return clientMethod;
        });

        let some = this._assertConnected().then(() => {
            let reduce = clientMethods.reduce((acc, clientMethod) => {
                return acc.then(res => {
                    if (!!res) {
                        return Promise.resolve(res);
                    } else {
                        return clientMethod();
                    }
                });
            }, Promise.resolve(null));
            return reduce;
        });
        return some;
    }

    _validate() {
        if (!Number.isInteger(this.config['reconnectIntervalSeconds'])) {
            throw new Error(`invalid reconnectIntervalSeconds: ${this.config['reconnectIntervalSeconds']}`);
        }
        if (this.config['reconnectIntervalSeconds'] < 1 || this.config['reconnectIntervalSeconds'] > (60 * 60)) {
            throw new Error(`reconnectIntervalSeconds is out of range: ${this.config['reconnectIntervalSeconds']}`);
        }
    }

    get _clients() {
        this._allClients = this._allClients || [this._mainRedisClient].concat(this._redisClients);
        return this._allClients;
    }

    get _onlineClients() {
        return Utils.shuffle(this._clients.filter(redis => redis.connected));
    }

}

module.exports = RedisStorage;
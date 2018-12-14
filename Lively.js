import Immutable from 'immutable';
import SocketIO from 'socket.io';
import Ajv from 'ajv';
import express from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import _ from 'lodash';
import path from 'path';
import cors from 'cors';
import fs from 'fs';

import User from './User';

class Lively {
    constructor({livelyOpts, expressOpts, mongoose, schemasPath, actionsPath}) {
        this.io = {};
        this.mongoose = mongoose;
    
        this.models = Immutable.Map();
        this.actions = Immutable.Map();
    
        this.users = Immutable.Map();
    
        this.actionQueue = [];
        this.currentAction = null;

        this.livelyOpts = livelyOpts;
        this.expressOpts = expressOpts;
        this.schemasPath = schemasPath;
        this.actionsPath = actionsPath;
    }

    sendEventToSubscribers(document, event) {
        const modelName = document.constructor.modelName;
        const _id = document._id;

        const subscription = `${modelName}#${_id}`;

        this.io.to(subscription).emit('lively_event', event);
    }

    addActionToQueue(sender, actionPayload) {
        this.actionQueue.push({
            sender,
            actionPayload
        });
    }

    sendNextAction() {
        clearTimeout(this.actionTimeout);
        this.currentAction = null;

        const nextAction = this.actionQueue.shift();

        if (nextAction) {
            this.sendAction(nextAction.sender, nextAction.actionPayload);
        }
    }

    setActionTimeout() {
        if (this.actionQueue.length > 0) {
            this.actionTimeout = setTimeout(() => {
                this.sendNextAction();
            }, this.livelyOpts.actionTimeout || 2000);
        }
    }

    validateActionPayload(schema, payload) {
        const ajv = new Ajv();

        const validate = ajv.compile(schema);
        const valid = validate(payload);

        return !valid ? validate.errors : true;
    }

    sendAction(sender, actionBody) {
        if (this.currentAction) {
            return this.addActionToQueue(sender, actionBody);
        } else {
            this.currentAction = { fired_at: Date.now(), sender, actionBody };
        }

        let type = actionBody.type;
        let payload = actionBody.payload;

        const action = this.getAction(type);
        const Model = this.getModel(action.model_type);

        const schemaCheck = this.validateActionPayload(action.schema, payload);

        if (schemaCheck === true) {
            action.fn(payload, sender, this, Model)
                .then(() => {
                    this.sendNextAction();
                }, (err) => {
                    sender.sendError(payload, err);
                    this.sendNextAction();
                })
        } else {
            sender.sendEvent({
                type: "LIVELY_ACTION_INVALID_SCHEMA", 
                payload: {
                    actionType: action.type,
                    errors: schemaCheck
                }
            })
        };

        this.setActionTimeout();
    }

    addAction(action) {
        console.log(`[Lively addAction]: Adding action ${action.type}, of Model ${action.model_type}`);
        this.actions = this.actions.set(action.type, action);
    }

    getAction(action_type) {
        return this.actions.get(action_type);
    }

    // TODO: Let people name their files in camelCase, snake_case, etc. Parse into CONSTANT_CASE.
    loadActions(pathToActions) {
        // recursive function to map files from directory
        const walkSync = (d) => {
            if (fs.statSync(d).isDirectory()) {
                return fs.readdirSync(d).map(f => {
                    return walkSync(path.join(d, f)); 
                })
            } else {
                return d; // A file
            }
        };

        _.forEach(walkSync(pathToActions), (libraries) => {
            // avoid to include files inside the same folder
            if (_.isArray(libraries)) {
                _.forEach(_.flattenDeep(libraries), (lib) => {
                    // check for eof
                    if (lib.indexOf('.js') === -1) return;

                    let action_type = lib.match(/\w+.js/g)[0].replace(".js", "");
                    let model_type = lib.replace(__dirname, "").match(/([A-Z])\w+/g)[0];

                    const action = require(lib);

                    action.model_type = model_type;
                    action.type = action_type;

                    if (action.endpoint) {
                        this.api[action.method](`/api${action.endpoint}`, action.middleware || function(req, res, next) { next() }, (req, res) => {
                            this.sendAction(res, {
                                type: action.type,
                                payload: req
                            })
                        })
                    }

                    this.addAction(action);
                })
            } else { // top level actions
                let action_type = libraries.match(/\w+.js/g)[0].replace(".js", "");
                
                const action = require(libraries);

                action.type = action_type;

                this.addAction(action);
            }
        });
    }

    getModel(type) {
        this.models.get(type);
    }

    addModel(model) {
        console.log(`[Lively addModel]: Adding model ${model.modelName}`);
        this.models = this.models.set(model.modelName, model);
    }

    loadModels(pathToSchemas) {
        // recursive function to map files from directory
        const walkSync = (d) => {
            if (fs.statSync(d).isDirectory()) {
                return fs.readdirSync(d).map(f => {
                    return walkSync(path.join(d, f)); 
                })
            } else {
                return d; // A file
            }
        };

        _.forEach(walkSync(pathToSchemas), (schema) => {
            let modelType = schema.match(/\w+.js/g)[0].replace(".js", "");
            const Model = require(schema); // Now we can access any of the Models from wherever. Just do lively.mongoose.model('Todo'), or lively.getModel('Todo').whatever
        
            this.addModel(Model);
        });
    }

    init() {
        if (this.schemasPath) this.loadModels(this.schemasPath);

        this.api = express();
        
        this.api.use(cors());
        this.api.use(bodyParser.json());

        if (this.actionsPath) this.loadActions(this.actionsPath);

        const server = http.createServer(this.api);
        const io = SocketIO(server);

        this.io = io;
    
        io.on('connection', (socket) => {
            const user = new User(socket, {});
            user.origin = socket.handshake.headers.origin;

            this.users = this.users.set(user._id, user);

            user.sendEvent({
                type: "LIVELY_INITIALIZED",
                payload: {}
            });

            socket.on('disconnect', () => {
                const socket_id = socket.id;

                this.users = this.users.filter(user => user.socket.id !== socket_id);
            });

            // actionPayload: { type: ReduxAction.type, payload: ReduxAction.payload }
            socket.on('lively_action', (actionPayload) => {
                const sender = this.users.find(user => user.socket.id === socket.id);
                this.sendAction(sender, actionPayload);
            });
        });

        server.listen(this.expressOpts.port, () => {
            console.log("Lively Express API init'd.");
        });
    };
}

export default Lively;
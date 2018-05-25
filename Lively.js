const Immutable = require('immutable');
const v4 = require('uuid').v4;
const SocketIO = require('socket.io');
const Ajv = require('ajv');
const express = require('express');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const http = require('http');
const bodyParser = require('body-parser');
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const TokenHandler = require('./util/tokenHandler');

const User = require('./User');
const UserSchema = require ('./schemas/User');

function Lively({expressOpts, mongoose, schemasPath, actionsPath}) {
    this.io = {};
    this.mongoose = mongoose;
    this.tokenHandler = new TokenHandler();

    this.models = Immutable.Map();
    this.actions = Immutable.Map();

    this.users = Immutable.Map();

    this.actionQueue = [];
    this.currentAction = null;

    this.sendEventToSubscribers = (document, event) => {
        const modelName = document.constructor.modelName;
        const _id = document._id;

        const subscription = `${modelName}#${_id}`;

        this.io.to(subscription).emit('lively_event', event);
    };

    this.addActionToQueue = (sender, actionPayload) => {
        this.actionQueue.push({
            sender,
            actionPayload
        });
    };

    this.sendNextAction = () => {
        const nextAction = this.actionQueue.shift();

        if (nextAction) {
            this.sendAction(nextAction.sender, nextAction.actionPayload);
        }
    };

    this.validateActionPayload = (schema, payload) => {
        const ajv = new Ajv();

        const validate = ajv.compile(schema);
        const valid = validate(payload);

        return !valid ? validate.errors : true;
    };

    this.sendAction = (sender, actionPayload) => {
        if (this.currentAction) {
            if ((Date.now() - this.currentAction.fired_at) / 1000 >= 2) {
                console.log(`${this.currentAction.actionPayload.type} took longer than 2 seconds to resolve, pushing ${actionPayload.type}`);
                this.currentAction = { fired_at: Date.now(), sender, actionPayload };
            } else {
                console.log(`Waiting on ${this.currentAction.actionPayload.type} to resolve, pushing to queue`, (Date.now() - this.currentAction.fired_at) / 1000);
                return this.addActionToQueue(sender, actionPayload);
            }
        } else {
            console.log(`Firing action ${actionPayload.type}`)
            this.currentAction = { fired_at: Date.now(), sender, actionPayload };
        }

        let type = actionPayload.type;
        let payload = actionPayload.payload;

        const action = this.getAction(type);
        const Model = this.getModel(action.model_type); // Can return undefined for top-level actions

        const schemaCheck = this.validateActionPayload(action.schema, payload);

        if (schemaCheck === true) {
            action.fn(payload, sender, this, Model)
                .then(() => {
                    console.log(`${type} resolved.`)
                    clearTimeout(this.actionTimeout);
                    this.currentAction = null;
                    this.sendNextAction();
                }, (err) => {
                    console.log("Caught error from action", err)
                    sender.sendError(payload, err);
                    clearTimeout(this.actionTimeout);
                    this.currentAction = null;
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

        this.actionTimeout = setTimeout(() => {
            console.log(` ${this.currentAction.actionPayload.type} took too long to resolve, pushing next queued action`);
            this.currentAction = null;
            this.sendNextAction();
        }, 2000);
    };

    this.addAction = (action) => {
        console.log(`[Lively addAction]: Adding action ${action.type}, of Model ${action.model_type}`);
        this.actions = this.actions.set(action.type, action);
    };

    this.getAction = action_type => this.actions.get(action_type);

    // TODO: Let people name their files in camelCase, snake_case, etc. Parse into CONSTANT_CASE.
    this.loadActions = (pathToActions) => {
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
                        console.log("Initing", action.endpoint, action.method)
                        this.api[action.method](`/api${action.endpoint}`, action.middleware || function(req, res, next) { next() }, (req, res) => {
                            console.log("Got past middleware")
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
    };

    this.getModels = () => {
        var models = {};

        this.models.map((model) => {
            models[model.modelName] = {
                _id: model._id,
                type: model.type,
                actions: this.actions.filter(action => action.model_type === model.modelName)
            }
        });

        return models;
    };

    this.getModel = (type) => {
        return this.models.get(type);
    };

    this.addModel = (model) => {
        console.log(`[Lively addModel]: Adding model ${model.modelName}`);
        this.models = this.models.set(model.modelName, model);
    };

    this.loadModels = (pathToSchemas) => {
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
    };

    // TODO: Move this to a separate SocketHandler.
    this.init = () => {
        console.log("Lively Server live at", Date());

        if (schemasPath) this.loadModels(schemasPath);

        const app = express();

        passport.use(UserSchema.createStrategy());
        passport.use(this.tokenHandler.passportStrategy);

        passport.serializeUser(UserSchema.serializeUser());
        passport.deserializeUser(UserSchema.deserializeUser());

        app.use(function(req, res, next){
            res.setHeader('Access-Control-Allow-Origin', 'http://localhost:4200');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Access-Control-Allow-Methods', 'POST,PUT,GET,DELETE,OPTIONS');
            next();
        });

        app.use(bodyParser.json({limit: '50mb'}));

        app.use(require('express-session')({
            secret: 'keyboard cat',
            resave: false,
            saveUninitialized: false
        }));

        app.use(passport.initialize());
        app.use(passport.session());

        this.api = app;

        if (actionsPath) this.loadActions(actionsPath);

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
                console.log("Got action, sender", sender)
                this.sendAction(sender, actionPayload);
            });
        });

        server.listen(expressOpts.port, () => {
            console.log("Lively Express API init'd.");
        });
    };

    this.init();

    return this;
}

module.exports = Lively; 
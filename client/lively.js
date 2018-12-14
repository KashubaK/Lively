
export default class Lively {
    io = {}

    events = []

    initialState = {
        readyToSendActions: false,

        actionsToSend: [],
        serverActionsToSend: [],
        ajaxCallsToSend: []
    }

    store = {}
    state = {}

    constructor() {
        this.initialize();
    }

    registerEvent(type, reducer) {
        this.events[type] = reducer;
    }

    dispatchClientAction(action) {
        if (this.state.readyToSendActions === true || action.type === "LIVELY_INITIALIZED") {
            this.store.dispatch(action);
        } else {
            this.store.dispatch({
                type: "LIVELY_ADD_POST_INIT_ACTION",
                payload: action
            });
        }
    }

    ajax(options, storedResolve, storedReject) {
        return new Promise((resolve, reject) => {
            if (this.state.readyToSendActions === true) {
                if (!options.headers) options.headers = {};
                    
                options.headers['X-Socket-ID'] = this.io.id;
        
                $.ajax(options)
                    .done(body => {
                        console.log("[lively ajax]: Received event:", body);
                        
                        this.dispatchClientAction(body);

                        if (storedResolve) return storedResolve(body.payload);
                        resolve(body.payload);
                    })
                    .fail(err => {
                        console.error(err);

                        if (storedReject) return storedReject(err);
                        reject(err);
                    })
            } else {
                this.store.dispatch({
                    type: "LIVELY_ADD_POST_INIT_AJAX",
                    payload: {
                        options,
                        resolve,
                        reject
                    }
                });
            }
        })
    }

    dispatchServerAction(action) {
        if (this.state.readyToSendActions === true) {
            console.log(`\n[LivelyClient dispatchServerAction]: Dispatching action to server`, action);
            this.io.emit("lively_action", action);
        } else {
            this.store.dispatch({
                type: "LIVELY_ADD_POST_INIT_SERVER_ACTION",
                payload: action
            });
        }
    }

    stateSubscriber() {
        const newState = this.store.getState();
        const oldState = this.state;

        const wasntReadyToDispatchActions = oldState.readyToSendActions !== newState.readyToSendActions;

        this.state = newState;

        if (wasntReadyToDispatchActions) {
            const actionsToSend = newState.actionsToSend;
            const serverActionsToSend = newState.serverActionsToSend;
            const ajaxCallsToSend = newState.ajaxCallsToSend;

            if (actionsToSend.length > 0) {
                actionsToSend.forEach(postInitAction => {
                    this.dispatchClientAction(postInitAction);
                });

                this.dispatchClientAction({type: "LIVELY_CLEAR_POST_INIT_ACTIONS"});
            }

            if (serverActionsToSend.length > 0) {
                serverActionsToSend.forEach(postInitAction => {
                    this.dispatchServerAction(postInitAction);
                });

                this.dispatchClientAction({type: "LIVELY_CLEAR_POST_INIT_SERVER_ACTIONS"});
            }

            if (ajaxCallsToSend.length > 0) {
                ajaxCallsToSend.forEach(ajaxCall => {
                    this.ajax(ajaxCall.options).then(ajaxCall.resolve, ajaxCall.reject);
                })

                this.dispatchClientAction({type: "LIVELY_CLEAR_POST_INIT_AJAX"});
            }
        }
        
        console.log(`\n[LivelyClient stateSubscriber]: New state`, this.state);
    }

    subscribe(fn) {
        this.store.subscribe(fn);
    }

    unsubscribe(fn) {
        this.store.unsubscribe(fn);
    }

    rootReducer(state = this.initialState, action) {
        const reducer = this.events[action.type];
        
        if (typeof reducer === "function") {
            return reducer(Object.assign({}, state), action);
        } else {
            console.error(`\n[LivelyClient rootReducer]: Unknown or incorrectly registered event: ${action.type}. Returning previous state.`);
            return state;
        }
    }

    initialize() {
        const store = Redux.createStore((state, action) => {
            return this.rootReducer(state, action);
        });

        store.subscribe(() => {
            this.stateSubscriber();
        });

        this.store = store;

        this.registerEvent("LIVELY_INITIALIZED", (state, action) => {
            state.readyToSendActions = true;

            return state;
        });

        this.registerEvent("LIVELY_ADD_POST_INIT_ACTION", (state, action) => {
            state.actionsToSend.push(action.payload);

            return state;
        });

        this.registerEvent("LIVELY_ADD_POST_INIT_AJAX", (state, action) => {
            state.ajaxCallsToSend.push(action.payload);

            return state;
        });

        this.registerEvent("LIVELY_ADD_POST_INIT_SERVER_ACTION", (state, action) => {
            state.serverActionsToSend.push(action.payload);

            return state;
        });

        this.registerEvent("LIVELY_CLEAR_POST_INIT_SERVER_ACTIONS", (state, action) => {
            state.serverActionsToSend = [];

            return state;
        });

        this.registerEvent("LIVELY_CLEAR_POST_INIT_AJAX", (state, action) => {
            state.ajaxCallsToSend = [];

            return state;
        })

        this.registerEvent("LIVELY_CLEAR_POST_INIT_ACTIONS", (state, action) => {
            state.actionsToSend = [];

            return state;
        });

        this.io = io(this.API_URL);

        this.io.on('lively_event', (event) => { 
            console.log(`\n[LivelyClient livelyEventListener]: Received event`, event);
            
            this.dispatchClientAction(event);
        });

        this.io.on('lively_error', (err) => {
            alert(err.error);
        })
    }
};

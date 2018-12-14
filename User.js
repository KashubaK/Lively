import { v4 } from 'uuid';
import Immutable from 'immutable';

export default class User {
    constructor(socket, data) {
        this._id = v4();

        this.socket = socket;
        this.data = data; // For your User model, e.g. { _id: ..., username: "test123", password: "fas98dhf3892hfdsf", ... }

        this.subscriptions = Immutable.List();
    }

    sendEvent(eventPayload) {
        this.socket.emit('lively_event', eventPayload);
    }

    sendError(actionPayload, error) { 
        this.socket.emit('lively_error', {actionPayload, error});
    }

    subscribeTo(document) {
        const modelName = document.constructor.modelName;
        const _id = document._id;

        const subscription = `${modelName}#${_id}`;

        this.subscriptions = this.subscriptions.push(subscription);
        this.socket.join(subscription);
    }

    unsubscribeFrom(document) {
        const modelName = document.constructor.modelName;
        const _id = document._id;

        const subscription = `${modelName}#${_id}`;

        this.subscriptions = this.subscriptions.filter(sub => sub !== subscription);
        this.socket.leave(subscription);
    }

    clearSubscriptions() {
        this.subscriptions.forEach((subscription) => {
            this.socket.leave(subscription);
        });

        this.subscriptions = this.subscriptions.clear();
    };
}
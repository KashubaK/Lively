const mongoose = require('mongoose');
const Lively = require('./Lively');

mongoose.connect(`mongodb://localhost:27017`);

const app = new Lively({
    expressOpts: { port: 8000 },
    mongoose: mongoose,
    schemasPath: __dirname + "/schemas", 
    actionsPath: __dirname + "/actions"
});

        

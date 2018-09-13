import Ethers from 'ethers';
import utils from 'utils';

const abiCoder = new Ethers.utils.AbiCoder();

const getFunctionSelector = abi => {
    return abi.name + '(' + getParamTypes(abi.inputs || []).join(',') + ')';
}

const getParamTypes = params => {
    return params.map(({ type }) => type);
}

const decodeOutput = (abi, output) => {
    if(abi.some(output => utils.hasProperty(output, 'name'))) {
        return abiCoder.decode(
            abi.map(({ name }) => name),
            abi.map(({ type }) => type),
            output
        )
    }

    return abiCoder.decode(
        abi.map(({ type }) => type),
        output
    );
};

export default class Method {
    constructor(contract, abi) {
        this.tronWeb = contract.tronWeb;
        this.contract = contract;

        this.abi = abi;        
        this.name = abi.name;

        this.inputs = abi.inputs || [];
        this.outputs = abi.outputs || [];

        this.signature = this.tronWeb.sha3(abi.name).slice(0, 8);
        this.functionSelector = getFunctionSelector(abi);
        this.injectPromise = utils.promiseInjector(this);

        this.defaultOptions = {
            feeLimit: 1000000000,
            callValue: 0,
            from: this.tronWeb.defaultAddress.hex, // Only used for send()
            shouldPollResponse: true // Only used for sign()
        };
    }

    onMethod(...args) {
        const types = getParamTypes(this.inputs);

        args.forEach((arg, index) => {
            if(types[index] == 'address')
                args[index] = this.tronWeb.address.toHex(arg).replace(/^(41)/, '0x')
        });

        return {
            call: (...methodArgs) => this._call(types, args, ...methodArgs),
            send: (...methodArgs) => this._send(types, args, ...methodArgs),
            watch: (...methodArgs) => this._watch(...methodArgs)
        }
    }

    async _call(types, args, options = {}, callback = false) {                
        if(utils.isFunction(options)) {
            callback = options;
            options = {};
        }
            
        if(!callback)
            return this.injectPromise(this._call, types, args, options);

        if(types.length !== args.length)
            return callback('Invalid argument count provided');

        if(!this.contract.address)
            return callback('Smart contract is missing address');

        if(!this.contract.deployed)
            return callback('Calling smart contracts requires you to load the contract first');

        const { stateMutability } = this.abi;

        if(![ 'pure', 'view' ].includes(stateMutability.toLowerCase()))
            return callback(`Methods with state mutability "${stateMutability}" must use send()`);

        options = { ...this.defaultOptions, ...options };

        const parameters = args.map((value, index) => ({
            type: types[index],
            value
        }));

        this.tronWeb.transactionBuilder.triggerSmartContract(
            this.contract.address,
            this.functionSelector,
            options.feeLimit,
            options.callValue,
            parameters,
            this.tronWeb.address.toHex(options.from),
        (err, transaction) => {
            if(err) 
                return callback(err);

            if(!utils.hasProperty(transaction, 'constant_result'))
                return callback('Failed to execute');

            try {
                let output = decodeOutput(this.outputs, '0x' + transaction.constant_result[0]);
                
                if(output.length === 1)
                    output = output[0];

                return callback(null, output);
            } catch(ex) {
                return callback(ex);
            }
        });
    }

    async _send(types, args, options = {}, privateKey = this.tronWeb.defaultPrivateKey, callback = false) {
        if(utils.isFunction(privateKey)) {
            callback = privateKey;
            privateKey = this.tronWeb.defaultPrivateKey;
        }

        if(utils.isFunction(options)) {
            callback = options;
            options = {};
        }
            
        if(!callback)
            return this.injectPromise(this._send, types, args, options, privateKey);

        if(types.length !== args.length)
            throw new Error('Invalid argument count provided');

        if(!this.contract.address)
            return callback('Smart contract is missing address');

        if(!this.contract.deployed)
            return callback('Calling smart contracts requires you to load the contract first');

        if(!privateKey || !utils.isString(privateKey))
            return callback('Invalid private key provided');

        const { stateMutability } = this.abi;

        if([ 'pure', 'view' ].includes(stateMutability.toLowerCase()))
                return callback(`Methods with state mutability "${stateMutability}" must use call()`);

        options = { ...this.defaultOptions, ...options };

        const parameters = args.map((value, index) => ({
            type: types[index],
            value
        }));

        try {
            const address = this.tronWeb.address.fromPrivateKey(privateKey);
            const transaction = await this.tronWeb.transactionBuilder.triggerSmartContract(
                this.contract.address,
                this.functionSelector,
                options.feeLimit,
                options.callValue,
                parameters,
                this.tronWeb.address.toHex(address)
            );

            if(!transaction.result || !transaction.result.result)
                return callback('Unknown error: ' + JSON.stringify(transaction, null, 2));

            const signedTransaction = await this.tronWeb.trx.sign(transaction.transaction, privateKey);
            const broadcast = await this.tronWeb.trx.sendRawTransaction(signedTransaction);

            if(!broadcast.result)
                return callback('Unknown error: ' + JSON.stringify(broadcast, null, 2));

            if(!options.shouldPollResponse)
                return callback(null, signedTransaction.txID);

            const checkResult = async (index = 0) => {
                if(index == 20) {
                    return callback({ 
                        error: 'Cannot find result in solidity node', 
                        transaction: signedTransaction
                    });
                }
                
                const output = await this.tronWeb.trx.getTransactionInfo(signedTransaction.txID);

                if(!Object.keys(output).length) {
                    return setTimeout(() => {
                        checkResult(index + 1);
                    }, 3000);
                }

                if(output.result && output.result == 'FAILED') {
                    return callback({
                        error: this.tronWeb.toUtf8(output.resMessage),
                        transaction: signedTransaction,
                        output
                    });
                }

                if(!utils.hasProperty(output, 'contractResult')) {
                    return callback({
                        error: 'Failed to execute: ' + JSON.stringify(output, null, 2),
                        transaction: signedTransaction,
                        output
                    });
                }

                let decoded = decodeOutput(this.outputs, '0x' + output.contractResult[0]);

                if(decoded.length === 1)
                    decoded = decoded[0];

                return callback(null, decoded);
            }

            checkResult();                    
        } catch(ex) {
            return callback(ex);
        }
    }

    async _watch(callback = false) {
        if(!utils.isFunction(callback))
            throw new Error('Expected callback to be provided');
        
        if(!this.contract.address)
            return callback('Smart contract is missing address');

        if(this.abi.type.toLowerCase() !== 'event')
            return callback('Invalid method type for event watching');

        if(!this.tronWeb.eventServer)
            return callback('No event server configured');

        let listener = false;
        let lastBlock = false;

        const getEvents = async () => {
            try {
                const events = await this.tronWeb.getEventResult(this.contract.address, this.name);
                const [ latestEvent ] = events.sort((a, b) => b.block - a.block);
                const newEvents = events.filter((event, index) => {
                    const duplicate = events.slice(0, index).some(priorEvent => (
                        JSON.stringify(priorEvent) == JSON.stringify(event)
                    ));

                    if(duplicate)
                        return false;

                    if(!lastBlock)
                        return true;            

                    return event.block > lastBlock;
                });

                if(latestEvent)
                    lastBlock = latestEvent.block;

                return newEvents;
            } catch(ex) {
                return Promise.reject(ex);
            }
        };

        const bindListener = () => {
            if(listener)
                clearInterval(listener);

            listener = setInterval(() => {
                getEvents().then(events => events.forEach(event => {
                    callback(null, utils.parseEvent(event, this.abi))
                })).catch(err => callback(err));
            }, 3000);
        };

        await getEvents();
        bindListener();

        return {
            start: bindListener(),
            stop: () => {
                if(!listener)
                    return;

                clearInterval(listener);
                listener = false;
            }
        }
    }
}
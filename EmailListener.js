import {EventEmitter} from 'node:events';
import {ImapFlow} from "imapflow";

export default class EmailListener extends EventEmitter {
    constructor(imapOpts) {
        super();
        this.imapOpts = imapOpts;
        this.client = null;
        this.lastSeqNum = 5259;
        this.inboxOpenTimeout = null;
    }

    async connect() {
        this.client = null;
        if (this.inboxOpenTimeout) {
            clearTimeout(this.inboxOpenTimeout);
            this.inboxOpenTimeout = null;
        }

        this.client = new ImapFlow(this.imapOpts);
        this.client.on('close', () => {
            console.log('imap close');
            this.emit('close');
            setTimeout(this.connect.bind(this), 1000);
        });
        this.client.on('error', err => {
            console.error('imap error', err);
        });
        this.client.on('exists', info => {
            console.log('imap exists', info);
            this.updateSeqNum(info.count);
        });
        this.client.on('expunge', info => {
            console.log('imap expunge', info);
            this.lastSeqNum--;
        });
        this.client.on('mailboxOpen', mailbox => {
            console.log('imap mailbox open', mailbox.path);
            if (mailbox.path === 'INBOX') {
                clearInterval(this.inboxOpenTimeout);
                this.inboxOpenTimeout = null;
            }
        });
        this.client.on('mailboxClose', mailbox => {
            console.log('imap mailbox close', mailbox.path);
        });

        console.log('imap connect');
        this.inboxOpenTimeout = setTimeout(() => {
            console.log('inbox open timeout');
            this.client.close();
        }, 5000);

        try {
            await this.client.connect();
            await this.client.getMailboxLock('INBOX');
            this.emit('connect');
            await this.updateSeqNum(this.client.mailbox.exists);
        } catch (e) {
            console.log('imap init error', e);
            // client.connect() failure emits 'close' event
            // if no event is emitted, inboxOpenTimeout will trigger
        }
    }

    async updateSeqNum(newSeqNum) {
        if (this.lastSeqNum === null) {
            console.log('seq num init to', newSeqNum);
            this.lastSeqNum = newSeqNum;
        } else if (this.lastSeqNum < newSeqNum) {
            const range = `${this.lastSeqNum + 1}:${newSeqNum}`;
            console.log('downloading sequence numbers', range);
            for await (let msgInfo of this.client.fetch(range, {envelope: true, source: true})) {
                this.emit('message', msgInfo);
            }
            this.lastSeqNum = newSeqNum;
        }
    }
}
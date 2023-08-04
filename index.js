import fs from 'node:fs';
import {promisify} from 'node:util';
import EmailListener from "./EmailListener.js";
import {simpleParser} from 'mailparser';
import {JSDOM} from 'jsdom';
import {URL} from 'node:url';
import {WebSocketServer} from 'ws';

const readFilePromise = promisify(fs.readFile);

class OdomsPos {
    constructor(auth) {
        this.auth = auth;
        this.wsServer = new WebSocketServer({
            host: '::',
            port: 6900,
            clientTracking: true
        });
    }

    async init() {
        await new Promise((res, rej) => {
            this.wsServer.on('listening', res);
            this.wsServer.on('error', rej);
        });
        this.wsServer.on('error', err => {
            console.error('WebSocketServer error', err);
        });
        this.wsServer.on('close', () => {
            console.error('WebSocketServer closed');
        });
        this.wsServer.on('connection', (websocket, request) => {
            const remoteAddress = request.client.remoteAddress;
            console.log('WebSocket connection from', remoteAddress);
            websocket.on('message', message => {
                try {
                    const parsed = JSON.parse(message);
                    if (parsed.type === 'ping') {
                        websocket.send('{"type":"pong"}');
                    } else {
                        console.error('WebSocket unexpected message', message);
                    }
                } catch (e) {
                    console.error('WebSocket message handler error', e);
                }
            });
            websocket.on('error', err => {
                console.error('WebSocket client', remoteAddress, 'error', err);
            });
            websocket.on('close', () => {
                console.log('WebSocket close', remoteAddress);
            });
        });

        const listener = new EmailListener({
            host: 'imap.gmail.com',
            port: 993,
            secure: true,
            auth: this.auth,
            maxIdleTime: 5000, // will detect dropped connections much faster
            logger: false
        });
        listener.on('message', async message => {
            try {
                console.log('received message', message.seq, 'from', message.envelope.from[0].address, 'subject', message.envelope.subject);
                if (message.envelope.subject.match(/^(.+) paid you \$([0-9]+)\.([0-9]{2})$/)) {
                    const parsed = await OdomsPos.parseVenmoEmail(message.source);
                    this.onVenmoMessage(parsed);
                }
            } catch (e) {
                console.error('message handler error', e);
            }
        });
        await listener.connect();
    }

    onVenmoMessage(paymentDetails) {
        console.log('emit venmo message', paymentDetails, 'to', this.wsServer.clients.size, 'ws clients');
        const messageStr = JSON.stringify({
            "type": "venmo",
            "payment": paymentDetails
        });
        for (let client of this.wsServer.clients) {
            client.send(messageStr);
        }
    }

    static getVenmoUserId(url) {
        const parsed = new URL(url);
        const userId = parsed.searchParams.get('user_id');
        if (typeof(userId) !== 'string' || !userId.match(/^[0-9]+$/)) {
            throw new Error('could not get user id from url ' + url);
        }
        return userId;
    }

    static async parseVenmoEmail(emailSource) {
        const emailParts = await simpleParser(emailSource);
        const dom = new JSDOM(emailParts.html);

        const mainTable = dom.window.document.querySelector('table#_story');

        const descriptionRow = mainTable.querySelector('tr');
        const payerImageEl = descriptionRow.querySelector('a[href^="https://venmo.com/code"] > img');
        const payerImageUrl = payerImageEl.getAttribute('src');
        if (!payerImageUrl.startsWith('https://pics.venmo.com/') && !payerImageUrl.startsWith('https://s3.amazonaws.com/venmo/')) {
            throw new Error('unexpected picture url ' + payerImageUrl);
        }

        const imageCell = payerImageEl.closest('td');
        const descriptionCell = imageCell.nextElementSibling;
        const userLinks = descriptionCell.querySelectorAll('a[href^="https://venmo.com/code"]');
        if (userLinks.length !== 2) {
            throw new Error('expected 2 users, found ' + userLinks.length);
        }

        if (userLinks[0].nextElementSibling !== userLinks[1].previousElementSibling) {
            throw new Error('expected 1 element between users');
        }
        const verb = userLinks[0].nextElementSibling.textContent.trim();
        if (verb !== 'paid') {
            throw new Error('unexpected verb ' + verb);
        }

        const senderName = userLinks[0].textContent.trim();
        const senderId = OdomsPos.getVenmoUserId(userLinks[0].getAttribute('href'));

        const receiverName = userLinks[1].textContent.trim()
        if (receiverName !== 'You') {
            throw new Error('expected "You" to receive money, found ' + receiverName);
        }
        const receiverId = OdomsPos.getVenmoUserId(userLinks[1].getAttribute('href'));

        const description = descriptionCell.querySelector('div > p').textContent.trim();

        const dateAmountTextRow = descriptionRow.nextElementSibling;
        if (dateAmountTextRow.textContent.trim() !== 'Transfer Date and Amount:') {
            throw new Error('unexpected date/amount text: ' + dateAmountTextRow.textContent.trim());
        }

        const dateAmountRow = dateAmountTextRow.nextElementSibling;
        const dateEl = dateAmountRow.querySelector('td > span');
        const date = dateEl.textContent.trim();

        const separatorEl = dateEl.nextElementSibling;
        if (separatorEl.textContent !== ' · ') {
            throw new Error('unexpected separator text ' + separatorEl.textContent);
        }

        const privacyImage = separatorEl.nextElementSibling;
        const privacy = privacyImage.getAttribute('alt');
        if (typeof(privacy) !== 'string') {
            throw new Error('unexpected privacy ' + privacy);
        }

        const amount = privacyImage.nextElementSibling.textContent.trim();
        const amountParts = amount.match(/^\+ \$([0-9]+)\.([0-9]{2})$/);
        if (!amountParts) {
            throw new Error('unexpected payment amount string ' + amount);
        }
        const amountCents = parseInt(amountParts[1]) * 100 + parseInt(amountParts[2]);

        const buttonsRow = dateAmountRow.nextElementSibling;
        const [likeButton, commentsButton] = buttonsRow.querySelectorAll('a[href^="https://venmo.com/story/"]');
        if (likeButton.textContent.trim() !== 'Like') {
            throw new Error('unexpected like button ' + likeButton.textContent.trim());
        }
        const likeUrl = likeButton.getAttribute('href');
        if (commentsButton.textContent.trim() !== 'Comment') {
            throw new Error('unexpected comment button ' + commentsButton.textContent.trim());
        }
        const commentsUrl = commentsButton.getAttribute('href');

        const auxInfo = mainTable.nextElementSibling;
        const cashOutLink = auxInfo.querySelector('a[href="https://venmo.com/cash_out"]');
        const paymentIdStr = cashOutLink.nextElementSibling.textContent.trim();
        const paymentId = paymentIdStr.match(/^Payment ID: ([0-9]+)$/)[1];

        return {senderName, senderId, receiverId, description, date, privacy, amountCents, likeUrl, commentsUrl, paymentId};
    }

    static async main() {
        // auth = {"user":"abc@gmail.com","pass":"myPassword"}
        // must use app password
        const auth = JSON.parse(await readFilePromise("./auth.json", 'utf8'));

        const odomsPos = new OdomsPos(auth);
        await odomsPos.init();
    }
}

OdomsPos.main().catch(err => {
    console.error('main error', err);
    process.exit(1);
});

import { Socket } from 'net';
import * as iconv from 'iconv-lite';
import * as debug from 'debug';
import { RosException } from '../RosException';

const info = debug('routeros-api:connector:receiver:info');
const error = debug('routeros-api:connector:receiver:error');

export interface ISentence {
    sentence: string;
    hadMore: boolean;
}

/**
 * Interface of the callback which is stored
 * the tag readers with their respective callbacks
 */
export interface IReadCallback {
    name: string;
    callback: (data: string[]) => void;
}

/**
 * Class responsible for receiving and parsing the socket
 * data, sending to the readers and listeners
 */
export class Receiver {

    /**
     * The socket which connects to the routerboard
     */
    private socket: Socket;

    /**
     * The host we are connected to - used for debugging
     */
    private host: string;

    /**
     * The registered tags to answer data to
     */
    private tags: Map<string, IReadCallback> = new Map();

    /**
     * The length of the current data chain received from
     * the socket
     */
    private dataLength: number = 0;

    /**
     * A pipe of all responses received from the routerboard
     */
    private sentencePipe: ISentence[] = [];

    /**
     * Flag if the sentencePipe is being processed to
     * prevent concurrent sentences breaking the pipe
     */
    private processingSentencePipe: boolean = false;

    /**
     * The current line being processed from the data chain
     */
    private currentLine: string = '';

    /**
     * The current reply received for the tag
     */
    private currentReply: string = '';

    /**
     * The current tag which the routerboard responded
     */
    private currentTag: string = '';

    /**
     * The current data chain or packet
     */
    private currentPacket: string[] = [];

    //private pending_re_count: number = 0;

    public crumbs: Buffer;


    /**
     * Receives the socket so we are able to read
     * the data sent to it, separating each tag
     * to the according listener.
     * 
     * @param socket
     */
    constructor(socket: Socket, host: string) {
        this.socket = socket;
        this.host = host;
        this.crumbs = Buffer.alloc(0);
    }

    /**
     * Register the tag as a reader so when
     * the routerboard respond to the command
     * related to the tag, we know where to send 
     * the data to
     * 
     * @param {string} tag 
     * @param {function} callback 
     */
    public read(tag: string, callback: (packet: string[]) => void): void {
        info('Reader of %s tag is being set', tag);
        this.tags.set(tag, {
            name   : tag,
            callback : callback
        });
    }

    /**
     * Stop reading from a tag, removing it
     * from the tag mapping. Usually it is closed
     * after the command has being !done, since each command
     * opens a new auto-generated tag
     * 
     * @param {string} tag 
     */
    public stop(tag: string): void {
        info('Not reading from %s tag anymore', tag);
        this.tags.delete(tag);
    }

    /**
     * Proccess the raw buffer data received from the routerboard,
     * decode using win1252 encoded string from the routerboard to
     * utf-8, so languages with accentuation works out of the box.
     * 
     * After reading each sentence from the raw packet, sends it
     * to be parsed
     * 
     * @param {Buffer} data 
     */
    public processRawData(data: Buffer): void {
        this.crumbs = Buffer.concat([this.crumbs, data]);

        //let index = 0;

        //while(true) {
        //    index = data.indexOf(Buffer.from('032172', 'hex'), index);

        //    if(index !== -1) {
        //        this.pending_re_count++;
        //        index++;
        //    } else {
        //        break;
        //    }
        //}

        if(this.crumbs.length > 3000) {
            let len = this.crumbs.length;
            this.crumbs = this.crumbs.slice(len-3000, len);
        }

        // Loop through the data we just received
        // from the socket
        while (data.length > 0) {

            // If this does not contain the beginning of a packet...
            if (this.dataLength > 0) {

                // If the length of the data we have in our buffer
                // is less than or equal to that reported by the
                // bytes used to dermine length...
                if (data.length <= this.dataLength) {

                    // Subtract the data we are taking from the length we desire
                    this.dataLength -= data.length;

                    // Add this data to our current line
                    this.currentLine += iconv.decode(data, 'win1252');

                    // If there is no more desired data we want...
                    if (this.dataLength === 0) {

                        // Push the data to the sentance
                        this.sentencePipe.push({
                            sentence: this.currentLine,
                            // ??WAT?? If we this we need more data...?
                            hadMore: (data.length !== this.dataLength)
                        });

                        // process the sentance and clear the line
                        this.processSentence();
                        this.currentLine = '';
                    }

                    // Break out of processRawData and wait for the next
                    // set of data from the socket
                    break;

                // If we have more data than we desire...
                } else {
                    // slice off the part that we desire
                    const tmpBuffer = data.slice(0, this.dataLength);

                    // decode this segment
                    const tmpStr = iconv.decode(tmpBuffer, 'win1252');

                    // Add this to our current line
                    this.currentLine += tmpStr;

                    // save our line...
                    const line = this.currentLine;

                    // clear the current line
                    this.currentLine = '';

                    // cut off the line we just pulled out
                    data = data.slice(this.dataLength);

                    // decode the next part of this packet
                    // Is it possible that we don't have all of the data to decode the length yet? if we only have 1 of the 3 bytes required? Is that possible?
                    const [start_index, length, required_bytes] = this.decodeLength(data);

                    if(required_bytes > data.length) {
                        console.log(`${this.host} we dont have enough data to decode this length '${line}' '${tmpStr}' (${start_index}, ${length}, ${required_bytes}) | ${this.crumbs.toString('base64')}`);
                    }

                    // Save this as our next desired length
                    this.dataLength = length;

                    // slice off the bytes used to describe the length
                    data = data.slice(start_index);

                    // If we only desire one more and its the end of the sentance...
                    if (this.dataLength === 1 && data.equals(Buffer.from('\0', 'ascii'))) {
                        this.dataLength = 0;
                        data = data.slice(1); // get rid of excess buffer
                    }
                    this.sentencePipe.push({
                        sentence: line,
                        hadMore: (data.length > 0)
                    });
                    this.processSentence();
                }

            // This is the beginning of this packet...
            // This ALWAYS gets run first
            } else {
                // returns back the start index of the data and the length
                const [start_index, length, required_bytes] = this.decodeLength(data);

                if(required_bytes > data.length) {
                  console.log(`${this.host} we dont have enough data to decode this length (${start_index}, ${length}, ${required_bytes}) | ${this.crumbs.toString('base64')}`);
                }

                // store how long our data is
                this.dataLength = length;

                // slice off the bytes used to describe the length
                data = data.slice(start_index);

                if (this.dataLength === 1 && data.equals(Buffer.from('\0', 'ascii'))) {
                    this.dataLength = 0;
                    data = data.slice(1); // get rid of excess buffer
                }
            }
        }

        //if(this.pending_re_count === 0) {
        //    this.crumbs = Buffer.alloc(0);
        //}

        //if(this.pending_re_count === 2 || (this.pending_re_count+1 % 50) === 0) {
        //    console.log(`${this.host} we have a lot of pending !re - ${this.pending_re_count} | ${this.crumbs.toString('base64')}`);
        //}
    }

    /**
     * Process each sentence from the data packet received.
     * 
     * Detects the .tag of the packet, sending the data to the
     * related tag when another reply is detected or if
     * the packet had no more lines to be processed.
     * 
     */
    private processSentence(): void {
        if (!this.processingSentencePipe) {
            info('Got asked to process sentence pipe');

            this.processingSentencePipe = true;

            const process = () => {
                if (this.sentencePipe.length > 0) {
                    const line = this.sentencePipe.shift();

                    if (!line.hadMore && this.currentReply === '!fatal') {
                        this.socket.emit('fatal');
                        return;
                    }

                    info('Processing line %s', line.sentence);

                    if (/^\.tag=/.test(line.sentence)) {
                        this.currentTag = line.sentence.substring(5);
                    } else if (/^!/.test(line.sentence)) {
                        //if(line.sentence === '!re') {
                        //    this.pending_re_count--;
                        //}
                        if (this.currentTag) {
                            info('Received another response, sending current data to tag %s', this.currentTag);
                            this.sendTagData(this.currentTag);
                        }
                        this.currentPacket.push(line.sentence);
                        this.currentReply = line.sentence;
                    } else {
                        this.currentPacket.push(line.sentence);
                    }

                    if (this.sentencePipe.length === 0 && this.dataLength === 0) {
                        if (!line.hadMore && this.currentTag) {
                            info('No more sentences to process, will send data to tag %s', this.currentTag);
                            this.sendTagData(this.currentTag);
                        } else {
                            info('No more sentences and no data to send');
                        }
                        this.processingSentencePipe = false;
                    } else {
                        process();
                    }
                } else {
                    this.processingSentencePipe = false;
                }

            };

            process();
        }
    }

    /**
     * Send the data collected from the tag to the
     * tag reader
     */
    private sendTagData(currentTag: string): void {
        const tag = this.tags.get(currentTag);
        if (tag) {
            info('Sending to tag %s the packet %O', tag.name, this.currentPacket);
            tag.callback(this.currentPacket);
        } else {
            throw new RosException('UNREGISTEREDTAG');
        }
        this.cleanUp();
    }

    /**
     * Clean the current packet, tag and reply state
     * to start over
     */
    private cleanUp(): void {
        this.currentPacket = [];
        this.currentTag = null;
        this.currentReply = null;
    }

    /**
     * Decodes the length of the buffer received
     *
     * Credits for George Joseph: https://github.com/gtjoseph
     * and for Brandon Myers: https://github.com/Trakkasure
     * 
     * @param {Buffer} data 
     */
    private decodeLength(data: Buffer): number[] {
        let len;
        let idx = 0;
        let required_bytes = 1;
        const b = data[idx++];

        if (b & 128) {
            if ((b & 192) === 128) {
                required_bytes = 2;
                len = ((b & 63) << 8) + data[idx++];
            } else {
                if ((b & 224) === 192) {
                    required_bytes = 3;
                    len = ((b & 31) << 8) + data[idx++];
                    len = (len << 8) + data[idx++];
                } else {
                    if ((b & 240) === 224) {
                        required_bytes = 4;
                        len = ((b & 15) << 8) + data[idx++];
                        len = (len << 8) + data[idx++];
                        len = (len << 8) + data[idx++];
                    } else {
                        len = data[idx++];
                        required_bytes = 5;
                        len = (len << 8) + data[idx++];
                        len = (len << 8) + data[idx++];
                        len = (len << 8) + data[idx++];
                    }
                }
            }
        } else {
            len = b;
        }

        return [idx, len, required_bytes];
    }

}

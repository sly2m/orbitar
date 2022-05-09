import { parseDocument } from 'htmlparser2';
import { Element, ChildNode } from 'domhandler';
import { escape as htmlEscape } from 'html-escaper';
import escapeHTML from 'escape-html';
import Url from 'url-parse';
import qs from 'qs';

export type ParseResult = {
    text: string;
    mentions: string[];
    urls: string[];
    images: string[];
};

export default class TheParser {
    private readonly allowedTags: Record<string, ((node: Element) => ParseResult) | boolean>;

    constructor() {
        this.allowedTags = {
            a: (node) => this.parseA(node),
            img: (node) => this.parseImg(node),
            irony: (node) => this.parseIrony(node),
            video: (node) => this.parseVideo(node),
            blockquote: true,
            b: true,
            i: true,
            u: true,
            strike: true,
        };
    }

    parse(text: string): ParseResult {
        const doc = parseDocument(text, {
            decodeEntities: false
        });

        return this.parseChildNodes(doc.childNodes);
    }

    private parseChildNodes(doc: ChildNode[]): ParseResult {
        return doc.reduce((p, c) => {
            const res = this.parseNode(c);
            p.text += res.text;
            p.mentions.push(...res.mentions);
            p.images.push(...res.images);
            p.urls.push(...res.urls);
            return p;
        }, { text: '', mentions: [], urls: [], images: [] });
    }

    private parseNode(node: ChildNode): ParseResult {
        if (node.type === 'text') {
            return this.parseText(node.data);
        }

        if (node.type === 'tag') {
            const allowed = this.allowedTags[node.tagName];
            if (allowed === true) {
                return this.parseAllowedTag(node);
            }
            else if (allowed) {
                return allowed(node);
            }
            else {
                return this.parseDisallowedTag(node);
            }
        }

        if (node.type === 'script') {
            return this.parseDisallowedTag(node);
        }

        if (node.type === 'directive') {
            return escapeHTML(`<${node.data}>`);
        }

        if (node.type === 'comment') {
            return escapeHTML(`<!-- ${node.data} -->`);
        }

        return { text: '', mentions: [], urls: [], images: [] };
    }

    private parseText(text: string): ParseResult {
        const regex = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*/g;
        const tokens: { type: string; data: string }[] = [];

        let sText = text;
        let match = regex.exec(sText);
        while (match) {
            const url = match[0];
            const pText = sText.substring(0, match.index);
            tokens.push({ type: 'text', data: pText });
            sText = sText.substring(match.index + url.length);
            tokens.push({ type: 'url', data: url });
            regex.lastIndex = 0; //match.index + url.length;

            match = regex.exec(sText);
        }
        tokens.push({ type: 'text', data: sText });

        const mentions = [];
        const urls = [];

        let escaped = tokens
            .map((token) => {
                if (token.type === 'text') {
                    // check for mentions
                    const mentionRes = token.data.match(/\B(?:@|\/u\/)([a-zа-яе0-9_-]+)/gi);
                    if (mentionRes) {
                        mentions.push(...mentionRes);
                    }
                    return htmlEscape(token.data);
                } else if (token.type === 'url') {
                    urls.push(token.data);
                    return this.processUrl(token.data);
                }
            })
            .join('');

        escaped = escaped.replace(/\r\n|\r|\n/g, '<br />\n');
        return { text: escaped, mentions, urls, images: [] };
    }

    processUrl(url: string) {
        const pUrl = new Url(url);

        const res =
            this.processYoutube(pUrl) ||
            this.processImage(pUrl) ||
            this.processVideo(pUrl);
        if (res !== false) {
            return res;
        }

        return `<a href="${encodeURI(decodeURI(url))}" target="_blank">${htmlEscape(decodeURI(url))}</a>`;
    }

    processImage(url: Url<string>) {
        if (url.pathname.match(/\.(jpg|gif|png|webp|jpeg)$/)) {
            return `<img src="${encodeURI(url.toString())}" alt=""/>`;
        }

        return false;
    }

    processVideo(url: Url<string>) {
        if (url.pathname.match(/\.(mp4|webm)$/)) {
            return `<video loop="" preload="metadata" controls="" width="500"><source src="${encodeURI(url.toString())}" type="video/mp4"></video>`;
        }

        return false;
    }

    processYoutube(url: Url<string>) {
        let videoId = '';
        let startTime = 0;

        const parseTime = (time: string) => {
            const groups = time.match(/^(\d+h)?(\d+m)?(\d+s?)?$/);
            if (!groups) {
                return 0;
            }
            const h = parseInt(groups[1], 10) || 0;
            const m = parseInt(groups[2], 10) || 0;
            const s = parseInt(groups[3], 10) || 0;
            return h * 3600 + m * 60 + s;
        };

        if (
            (url.host === 'youtube.com' || url.host === 'www.youtube.com') &&
            url.query &&
            url.pathname === '/watch'
        ) {
            const q = qs.parse(url.query.substring(1));
            if (typeof q.v === 'string') {
                videoId = q.v;
            }
            if (typeof q.t === 'string') {
                startTime = parseTime(q.t);
            }
        }
        else if (url.host === 'youtu.be') {
            videoId = url.pathname.substring(1);
            if (url.query) {
                const q = qs.parse(url.query.substring(1));
                if (typeof q.t === 'string') {
                    startTime = parseTime(q.t);
                }
            }
        }
        else {
            return false;
        }

        if (!videoId) {
            return false;
        }

        let embed = `https://www.youtube.com/embed/${videoId}`;
        if (startTime) {
            embed += '?start=' + startTime;
        }

        // noinspection HtmlDeprecatedAttribute
        return `<iframe width="500" height="282" src="${encodeURI(embed)}" allowfullscreen frameborder="0"></iframe>`;
    }

    parseAllowedTag(node: Element): ParseResult {
        const haveChild = node.children.length > 0;
        let text = `<${node.name}${haveChild ? '' : '/'}>`;
        const res = this.parseChildNodes(node.children);
        text += res.text;
        text += `</${node.name}>`;
        return { ...res, text };
    }

    parseDisallowedTag(node: Element): ParseResult {
        const haveChild = node.children.length > 0;
        let text = `<${node.name}`;
        for (const a in node.attribs) {
            text += ` ${a}="${node.attribs[a]}"`;
        }
        text += haveChild ? '>' : '/>';
        text = htmlEscape(text);
        const result = this.parseChildNodes(node.children);
        text += result.text;
        text += htmlEscape(`</${node.name}>`);
        return { ...result, text };
    }

    parseA(node: Element): ParseResult {
        const url = node.attribs['href'] || '';
        const regex = /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*$/;
        if (!url.match(regex)) {
            return this.parseDisallowedTag(node);
        }

        const result = this.parseChildNodes(node.children);
        const text = `<a href="${encodeURI(url)}" target="_blank">${result.text}</a>`;

        return { ...result, text, urls: [ ...result.urls, url ] } ;
    }

    parseImg(node: Element): ParseResult {
        const url = node.attribs['src'] || '';
        const regex = /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*$/;
        if (!url.match(regex)) {
            return this.parseDisallowedTag(node);
        }

        return { text: `<img src="${encodeURI(url)}" alt=""/>`, mentions: [], urls: [], images: [url] };
    }

    parseVideo(node: Element): ParseResult {
        const url = node.attribs['src'] || '';
        const regex = /^https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b[-a-zA-Z0-9()@:%_+.~#?&/=]*$/;
        if (!url.match(regex)) {
            return this.parseDisallowedTag(node);
        }

        const text = `<video loop="" preload="metadata" controls="" width="500"><source src="${encodeURI(url)}" type="video/mp4"></video>`;

        return { text, mentions: [], urls: [], images: [url] };
    }

    parseIrony(node: Element): ParseResult {
        const result = this.parseChildNodes(node.children);
        const text = `<span class="irony">${result.text}</span>`;
        return { ...result, text };
    }
}
import Cookies from 'js-cookie';

type APIResponseError = {
    result: 'error';
    code: string;
    message: string;
};
type APIResponseSuccess = {
    result: 'success';
    payload: Object;
    sync: string;
};
type APIResponse = APIResponseError | APIResponseSuccess;

export class APIError extends Error {
    public code: string;
    public statusCode?: number;

    constructor(code: string, message: string, statusCode?: number) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}

export default class APIBase {
    private sessionId?: string;
    private readonly endpoint: string;
    private sync: number = 0;

    constructor() {
        this.sessionId = Cookies.get('session');
        this.endpoint = '//api.' + process.env.REACT_APP_ROOT_DOMAIN + '/api/v1';
    }

    async request<T>(url: string, payload: object): Promise<T> {
        let headers: any = {
            'Content-Type': 'application/json',
        };
        if (this.sessionId) {
            headers['X-Session-Id'] = this.sessionId;
        }
        let response = await fetch(
            this.endpoint + url,
            {
                method: 'POST',
                body: JSON.stringify(payload),
                // mode: 'cors',
                // credentials: 'include',
                headers: headers
            }
        );

        if (response.status === 429) {
            throw new APIError('rate-limit', 'Rate limit exceeded', response.status);
        }

        let sessionId = response.headers.get('x-session-id');
        if (sessionId) {
            this.sessionId = sessionId;
            Cookies.set('session', sessionId, { domain: '.' + process.env.REACT_APP_ROOT_DOMAIN, expires: 365 })
        }

        let responseJson = await response.json() as APIResponse;

        if (responseJson.result === 'error') {
            throw new APIError(responseJson.code, responseJson.message, response.status);
        }

        if (!responseJson.payload) {
            throw new APIError('no-payload', 'Payload required', response.status);
        }

        if (responseJson.sync) {
            let cTime = new Date();
            let rTime = new Date(responseJson.sync);
            this.sync = Math.round((cTime.getTime() - rTime.getTime()) / 1000 / 900) / 4 * 3600 * 1000;
        }

        return responseJson.payload as T;
    }

    fixDate(date: Date) {
        return new Date(date.getTime() + this.sync);
    }
}

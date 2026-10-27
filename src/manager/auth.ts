import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, watchFile, unwatchFile } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Request, Response, NextFunction } from 'express';
interface Credential { salt: string; hash: string; revision: string }
export class Auth {
    readonly cookie: string;
    private key: string;
    constructor(id: string, password: string, keyFile: string, private accessFile = keyFile + '.password.json') {
        this.cookie = `cortico_${createHash('sha256').update(id).digest('hex').slice(0, 16)}_session`;
        if (!existsSync(keyFile)) {
            mkdirSync(dirname(keyFile), { recursive: true });
            writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
        }
        this.key = readFileSync(keyFile, 'utf8');
        // Import an explicitly supplied existing password once; never overwrite a saved password.
        if (!this.configured && password) this.store(password, true);
    }
    onChange(listener: () => void) {
        watchFile(this.accessFile, {interval: 500, persistent: false}, listener);
        return () => unwatchFile(this.accessFile, listener);
    }
    get enabled() { return true; }
    get cookieName() { return this.cookie; }
    verify(token: string | null) { return !!token && this.configured && this.same(token, this.issue()); }
    private failures: Promise<void> = Promise.resolve();
    async login(candidate: string) {
        if (this.verifyPassword(candidate)) return true;
        this.failures = this.failures.then(() => new Promise<void>(resolve => setTimeout(resolve, 1000)));
        await this.failures;
        return false;
    }
    logout() {
        const value=this.credential();
        if(value) { value.revision=randomBytes(32).toString('hex'); this.persist(value); }
    }
    get configured() { return existsSync(this.accessFile); }
    private credential(): Credential | null { return this.configured ? JSON.parse(readFileSync(this.accessFile, 'utf8')) : null; }
    private store(password: string, initial = false) {
        const salt = randomBytes(16).toString('hex');
        const value: Credential = { salt, hash: scryptSync(password, salt, 32).toString('hex'), revision: randomBytes(32).toString('hex') };
        this.persist(value, initial);
    }
    private persist(value: Credential, initial = false) {
        mkdirSync(dirname(this.accessFile), {recursive: true});
        if (initial) writeFileSync(this.accessFile, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
        else {
            const temp = this.accessFile + '.tmp';
            writeFileSync(temp, JSON.stringify(value), {mode: 0o600});
            renameSync(temp, this.accessFile);
        }
    }
    same(a: string, b: string): boolean { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }
    private verifyPassword(password: unknown) {
        const c = this.credential();
        return typeof password === 'string' && password.length <= 256 && !!c && this.same(scryptSync(password, c.salt, 32).toString('hex'), c.hash);
    }
    issue() { const c = this.credential(); return c ? createHmac('sha256', this.key).update(c.revision).digest('hex') : ''; }
    logged(req: Pick<Request, 'headers'>): boolean {
        const v = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(this.cookie + '='))?.slice(this.cookie.length + 1);
        const token = this.issue();
        return !!v && !!token && this.same(v, token);
    }
    private issueCookie(res: Response) { res.setHeader('Set-Cookie', `${this.cookie}=${this.issue()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`); }
    logoutRequest(req: Request, res: Response) {
        if (this.logged(req)) {
            const value = this.credential()!;
            value.revision = randomBytes(32).toString('hex');
            this.persist(value);
        }
        res.setHeader('Set-Cookie', `${this.cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`); res.json({ok:true}); }
    async loginRequest(req: Request, res: Response): Promise<void> {
        if (typeof req.body?.password !== 'string' || !(await this.login(req.body.password))) { res.status(401).json({error: this.configured ? '密码不正确' : '请先在管理中心设置密码'}); return; }
        this.issueCookie(res); res.json({ok:true});
    }
    setup(req: Request, res: Response) {
        if (this.configured) { res.status(409).json({error:'密码已设置，请登录'}); return; }
        if (!this.validate(req, res)) return;
        this.store(req.body.password, true); this.issueCookie(res); res.json({ok:true});
    }
    change(req: Request, res: Response) {
        if (!this.verifyPassword(req.body?.currentPassword)) { res.status(400).json({error:'当前密码不正确'}); return; }
        if (!this.validate(req, res)) return;
        this.store(req.body.password); this.logoutRequest(req, res);
    }
    private validate(req: Request, res: Response) {
        const {password, confirmPassword} = req.body || {};
        if (typeof password !== 'string' || password.length < 8 || password.length > 256) { res.status(400).json({error:'密码长度需为 8–256 个字符'}); return false; }
        if (password !== confirmPassword) { res.status(400).json({error:'两次输入的密码不一致'}); return false; }
        return true;
    }
    guard = (req: Request, res: Response, next: NextFunction): void => {
        if (!this.logged(req)) { res.status(401).json({error:'请先登录这个后台'}); return; }
        next();
    };
}
/** One managed installation owns one login session across its ports. */
export function managementAuth(root: string, password = '') {
    root = resolve(root);
    return new Auth(`manager:${root}`, password, join(root, 'manager-auth.key'), join(root, 'access.json'));
}
/** Browser writes must originate from this listening host; internal requests omit Origin. */
export function sameOrigin(req: Request, res: Response, next: NextFunction): void {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        res.status(403).json({ error: '请求来源不匹配' });
        return;
    }
    next();
}

/** Manager settings share the role WebUI settings renderer. */
import { mountSettings } from '../features/settings/index.ts';
import { createWebUi } from '../ui/index.ts';
import { Lifecycle } from '../core/lifecycle.ts';
import { Router } from '../core/router.ts';
import { applyStoredTheme } from '../theme/studio.ts';
import type { InjectedTheme } from '../../shared/theme.ts';
export function initTheme(theme: InjectedTheme) { applyStoredTheme(document,{injected:theme,legacy:null}); }
export function nativeSettings(root: HTMLElement, onError: (error:unknown)=>void) {
    const lifecycle = new Lifecycle(onError);
    const memo = {get<T>(key:string, fallback:T):T { const raw=localStorage.getItem('manager.settings.'+key); return raw===null?fallback:JSON.parse(raw); },set(key:string,value:unknown){localStorage.setItem('manager.settings.'+key,JSON.stringify(value));}};
    const ui=createWebUi({memo,overlayHost:document.body,signal:lifecycle.signal});
    const router=new Router({win:window,confirmLeave:message=>ui.confirm({title:message}),onError});
    mountSettings({root,lifecycle,signal:lifecycle.signal,ui,router,route:{segments:['settings'],query:{},raw:'settings'},capabilities:{auth:true},onError});
    return ()=>lifecycle.dispose();
}

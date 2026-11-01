import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {expect,it,vi} from 'vitest';
import {MinecraftWorldProxy} from '../../../src/worlds/minecraft/proxy.ts';
import {MINECRAFT_DEFAULTS,type MinecraftConfigSection} from '../../../src/worlds/minecraft/config.ts';

function fixture(){
  const cfg=structuredClone(MINECRAFT_DEFAULTS) as unknown as MinecraftConfigSection;cfg.enabled=false;cfg.client.enabled=false;
  const proxy=new MinecraftWorldProxy({cfg});
  const log={child(){return this;},trace(){},debug(){},info(){},warn(){},error(){},emit(){}};
  const host={log,pushEvent:async(e:unknown)=>e} as any;
  return {proxy,internals:proxy as any,host};
}
async function close(child:ChildProcess){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=once(child,'exit');child.kill();await exited;
}

it('initialization rejection retires the actual fork before returning to a retry',async()=>{
  const {proxy,internals,host}=fixture();let owned:ChildProcess|undefined;
  const rpc=internals.rpc.bind(proxy);
  const intercepted=vi.spyOn(internals,'rpc').mockImplementation((req:any,timeout:any)=>{
    if(req.kind==='init'){owned=internals.child;return Promise.reject(new Error('initialization timeout'));}
    return rpc(req,timeout);
  });
  try{
    await expect(proxy.start(host)).rejects.toThrow('initialization timeout');
    expect(owned).toBeDefined();
    expect(owned!.exitCode!==null||owned!.signalCode!==null).toBe(true);
    expect(internals.child).toBeNull();
    expect(internals.restartTimer).toBeNull();
  }finally{intercepted.mockRestore();await proxy.stop();if(owned)await close(owned);}
},30000);

it('a stale child exit cannot clear its replacement or start a concurrent owner',async()=>{
  const {proxy,internals}=fixture();
  const idle=()=>spawn(process.execPath,['-e','process.on("message",()=>{});setInterval(()=>{},1000)'],
    {stdio:['ignore','ignore','ignore','ipc']});
  const old=idle(),current=idle();
  try{
    await close(old);internals.child=current;internals.ready=true;
    internals.onExit(old,1);
    expect(internals.child).toBe(current);expect(internals.ready).toBe(true);
    await expect(internals.spawn()).rejects.toThrow('受管引擎');
    expect(internals.child).toBe(current);expect(current.exitCode).toBeNull();
  }finally{await close(old);await close(current);await proxy.stop();}
});

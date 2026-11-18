export const dispatcherFixtureSource=`
import React from 'react';
import '/bot-mentions.css';
import {createRoot} from 'react-dom/client';
import {Dispatcher} from '/Dispatcher.tsx';
import {IntegrationCredentialEntry} from '/IntegrationCredentialEntry.tsx';
import {TypeSafeConnection} from '/TypeSafeConnection.tsx';
import {installChatDrop} from '/chat-drop.ts';
installChatDrop();
const root=createRoot(document.getElementById('root'));
const agents=[{id:'lead',name:'Lead',role:'Builder'},{id:'worker',name:'Worker',role:'Reviewer'}];
window.opened=[];
const api=async(path,method='GET',body,options)=>{
 const response=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json',...(options?.sensitive?{'X-Synthetic-Sensitive':'yes'}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:options?.signal});
 const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'Synthetic failure'),{status:response.status});return data;
};
window.mount=()=>root.render(<Dispatcher api={api} agents={agents} onOpenWork={(...ids)=>window.opened.push(ids)}/>);
window.unmount=()=>root.render(null);window.mount();
window.mountSecure=(autoFocus,kind)=>root.render(kind==='typesafe'?<TypeSafeConnection api={api} request={{runId:'focus-run',interactionId:'focus-interaction'}} autoFocus={autoFocus}/>:<IntegrationCredentialEntry api={api} runId='focus-run' interactionId='focus-interaction' autoFocus={autoFocus} onConnected={()=>{}} onCancel={async()=>{}}/>);
`;

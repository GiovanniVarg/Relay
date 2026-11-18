import {Moon,Sun,Monitor} from 'lucide-react';
import type {Appearance} from '../shared/types';
export function AppearanceControl({preference,pending,onChange,icon=false}:{preference:Appearance;pending:boolean;onChange:(value:Appearance)=>void;icon?:boolean}){
 const Icon=preference==='system'?Monitor:preference==='light'?Sun:Moon;
 if(icon)return <button type="button" className="icon-button appearance-icon" disabled={pending} aria-label={'Appearance: '+preference+'. Change appearance'} title={'Appearance: '+preference} onClick={()=>onChange(preference==='system'?'light':preference==='light'?'dark':'system')}><Icon size={18}/></button>;
 return <label className="appearance-control"><span><Icon size={17}/>Appearance</span><select aria-label="Appearance" disabled={pending} value={preference} onChange={event=>onChange(event.target.value as Appearance)}><option value="light">Light</option><option value="dark">Dark</option><option value="system">System</option></select><small>{pending?'Saving appearance…':'System follows your device appearance.'}</small></label>;
}

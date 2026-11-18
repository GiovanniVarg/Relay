import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ProviderImage,ProviderRequest} from '../../shared/types.js';
import {requestImages} from '../attachment-context.js';
export const IMAGE_CHUNK_BYTES=192*1024;
export interface ImageMetadata extends Omit<ProviderImage,'data'> {byteLength:number;chunks:number;}
const keys=['attachmentId','messageId','sha256','mimeType','width','height'];
const identity=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const digest=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
export const manifestSha256=(manifest:readonly ImageMetadata[])=>digest(JSON.stringify(manifest));
export function validateManifest(value:unknown):asserts value is ImageMetadata[]{
 if(!Array.isArray(value)||value.length<1||value.length>4)throw Error('Invalid image manifest');let total=0;const ids=new Set<string>();
 for(const m of value){if(!object(m)||Object.keys(m).length!==8||Object.keys(m).some(k=>![...keys,'byteLength','chunks'].includes(k))||!identity(m.attachmentId)||!identity(m.messageId)||ids.has(m.attachmentId)||!['image/png','image/jpeg','image/webp'].includes(m.mimeType)||typeof m.sha256!=='string'||!/^[a-f0-9]{64}$/.test(m.sha256)||!Number.isSafeInteger(m.width)||!Number.isSafeInteger(m.height)||m.width<1||m.height<1||m.width>8192||m.height>8192||m.width*m.height>16000000||!Number.isSafeInteger(m.byteLength)||m.byteLength<1||m.byteLength>4*1024*1024||m.chunks!==Math.ceil(m.byteLength/IMAGE_CHUNK_BYTES))throw Error('Invalid image manifest');ids.add(m.attachmentId);total+=m.byteLength;}
 if(total>16*1024*1024)throw Error('Image input exceeds byte budget');
}
function refs(request:Pick<ProviderRequest,'history'>,manifest:readonly ImageMetadata[]){
 const seen=new Set<string>();for(const m of request.history){if(m.imageRefs===undefined)continue;if(m.role!=='user'||!Array.isArray(m.imageRefs)||m.imageRefs.length>4||!identity(m.messageId))throw Error('Invalid original image references');const own=new Set<string>();for(const id of m.imageRefs){const image=manifest.find(i=>i.attachmentId===id);if(!identity(id)||own.has(id)||!image||image.messageId!==m.messageId)throw Error('Invalid original image references');own.add(id);seen.add(id);}}
 if(seen.size!==manifest.length)throw Error('Image table does not match original references');
}
export function prepareImages(request:Pick<ProviderRequest,'history'>,images:readonly ProviderImage[]=[]):{images:ProviderImage[];manifest?:ImageMetadata[]}{
 if(!Array.isArray(images)||images.length>4)throw Error('Invalid private image table');
 const snapshot:ProviderImage[]=images.map(i=>{if(!object(i)||Object.keys(i).length!==7||Object.keys(i).some(k=>![...keys,'data'].includes(k))||typeof i.data!=='string'||i.data.length>4*Math.ceil(4*1024*1024/3))throw Error('Invalid private image input');return {...i} as ProviderImage;});
 const manifest=snapshot.map(({data,...m})=>{const bytes=Buffer.from(data,'base64');if(bytes.toString('base64')!==data)throw Error('Invalid private image encoding');return {...m,byteLength:bytes.length,chunks:Math.ceil(bytes.length/IMAGE_CHUNK_BYTES)};});
 if(manifest.length)validateManifest(manifest);refs(request,manifest);requestImages({...request,imageTable:snapshot});return {images:snapshot,...(manifest.length?{manifest}:{})};
}
export class ImageAssembler {
 private buffers:Buffer[][]=[];private initialized=false;private invalid=false;private imageIndex=0;private chunkIndex=0;
 constructor(private request:Pick<ProviderRequest,'history'>,private expected:readonly ImageMetadata[]){validateManifest(expected);refs(request,expected);}
 init(payload:unknown){if(this.invalid||this.initialized||!object(payload)||Object.keys(payload).length!==1||!isDeepStrictEqual(payload.images,this.expected))throw Error('Invalid image initialization');this.initialized=true;this.buffers=this.expected.map(()=>[]);}
 chunk(p:any){if(this.invalid||!this.initialized||!object(p)||Object.keys(p).length!==3||p.imageIndex!==this.imageIndex||p.chunkIndex!==this.chunkIndex||typeof p.data!=='string')throw Error('Invalid image chunk ordering');const m=this.expected[this.imageIndex];if(!m)throw Error('Extra image chunk');const length=Math.min(IMAGE_CHUNK_BYTES,m.byteLength-this.chunkIndex*IMAGE_CHUNK_BYTES);if(p.data.length!==4*Math.ceil(length/3))throw Error('Invalid image chunk size');const bytes=Buffer.from(p.data,'base64');if(bytes.length!==length||bytes.toString('base64')!==p.data)throw Error('Invalid image chunk encoding');this.buffers[this.imageIndex].push(bytes);if(++this.chunkIndex===m.chunks){this.imageIndex++;this.chunkIndex=0;}}
 get complete(){return !this.invalid&&this.initialized&&this.imageIndex===this.expected.length;}
 finish():ProviderImage[]{if(!this.complete)throw Error('Incomplete image initialization');const images=this.expected.map(({byteLength,chunks,...m},i)=>{const bytes=Buffer.concat(this.buffers[i]);if(bytes.length!==byteLength||digest(bytes)!==m.sha256)throw Error('Image digest mismatch');return {...m,data:bytes.toString('base64')};});requestImages({...this.request,imageTable:images});return images;}
 clear(){for(const chunks of this.buffers)for(const bytes of chunks)bytes.fill(0);this.buffers=[];this.invalid=true;}
}

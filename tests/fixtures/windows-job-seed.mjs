import {DatabaseSync} from 'node:sqlite';
import{join}from'node:path';
const db=new DatabaseSync(join(process.argv[2],'relay.sqlite'));
db.exec('CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id))');
db.prepare('INSERT INTO records VALUES(?,?,?)').run('fixture','saved','{"unchanged":true}');
db.close();

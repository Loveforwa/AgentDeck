// 内容哈希：DocFile.hash 和 baseHash 用 sha1（十六进制）；“核对过”的记录用 git 的 blob id（和 git hash-object 一样）。

import { createHash } from 'node:crypto';

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 和 `git hash-object` 算的一样：sha1("blob <字节数>\0" + 内容)。 */
export function gitBlobId(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Large-blob storage ([00] §4, [12] §1): filesystem by default, S3-compatible optional. Content-addressed refs. */
export interface ObjectStore {
  put(data: Buffer | string, contentType?: string): Promise<string>; // returns ref `obj:<sha256>`
  get(ref: string): Promise<Buffer>;
  exists(ref: string): Promise<boolean>;
}

export function objectRef(data: Buffer): string {
  return 'obj:' + createHash('sha256').update(data).digest('hex');
}

export class FsObjectStore implements ObjectStore {
  constructor(private root: string) {}
  private pathFor(ref: string) {
    const h = ref.replace(/^obj:/, '');
    return join(this.root, h.slice(0, 2), h);
  }
  async put(data: Buffer | string): Promise<string> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const ref = objectRef(buf);
    const p = this.pathFor(ref);
    await mkdir(dirname(p), { recursive: true });
    try {
      await stat(p);
    } catch {
      await writeFile(p, buf);
    }
    return ref;
  }
  async get(ref: string): Promise<Buffer> {
    return readFile(this.pathFor(ref));
  }
  async exists(ref: string): Promise<boolean> {
    try {
      await stat(this.pathFor(ref));
      return true;
    } catch {
      return false;
    }
  }
}

export class S3ObjectStore implements ObjectStore {
  private client: any;
  constructor(
    private bucket: string,
    private prefix: string,
    private region: string,
  ) {}
  private async s3() {
    if (!this.client) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      this.client = new S3Client({ region: this.region });
    }
    return this.client;
  }
  private key(ref: string) {
    return this.prefix + ref.replace(/^obj:/, '');
  }
  async put(data: Buffer | string, contentType = 'application/octet-stream'): Promise<string> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const ref = objectRef(buf);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.s3()).send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(ref), Body: buf, ContentType: contentType }));
    return ref;
  }
  async get(ref: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const res = await (await this.s3()).send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(ref) }));
    return Buffer.from(await res.Body.transformToByteArray());
  }
  async exists(ref: string): Promise<boolean> {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      await (await this.s3()).send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(ref) }));
      return true;
    } catch {
      return false;
    }
  }
}

export class MemoryObjectStore implements ObjectStore {
  private m = new Map<string, Buffer>();
  async put(data: Buffer | string) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const ref = objectRef(buf);
    this.m.set(ref, buf);
    return ref;
  }
  async get(ref: string) {
    const b = this.m.get(ref);
    if (!b) throw new Error(`object ${ref} not found`);
    return b;
  }
  async exists(ref: string) {
    return this.m.has(ref);
  }
}

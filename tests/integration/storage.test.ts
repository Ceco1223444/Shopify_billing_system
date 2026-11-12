import { beforeAll, describe, expect, it } from 'vitest';
import { adminClient, anonClient, signedInClient, type Client } from '../support/clients';
import { uniq } from '../support/schema';
import { ensureTestUsers, TEST_USERS } from '../support/users';

// 1x1 transparent PNG
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
);

let packer: Client;
let owner: Client;
let outsider: Client;

beforeAll(async () => {
  await ensureTestUsers();
  packer = await signedInClient(TEST_USERS.packer.email, TEST_USERS.packer.password);
  owner = await signedInClient(TEST_USERS.owner.email, TEST_USERS.owner.password);
  outsider = await signedInClient(TEST_USERS.outsider.email, TEST_USERS.outsider.password);
});

describe('private buckets', () => {
  it('members upload and open files via signed URLs; others cannot; only the owner deletes', async () => {
    const path = `test/${uniq('photo')}.png`;
    const bucket = () => packer.storage.from('product-photos');

    const { error: uploadError } = await bucket().upload(path, PNG, { contentType: 'image/png' });
    expect(uploadError).toBeNull();

    // Signed URL works without any login...
    const { data: signed, error: signError } = await bucket().createSignedUrl(path, 60);
    expect(signError).toBeNull();
    expect((await fetch(signed!.signedUrl)).status).toBe(200);

    // ...but the plain public URL does not (bucket is private).
    const publicUrl = anonClient().storage.from('product-photos').getPublicUrl(path).data.publicUrl;
    expect((await fetch(publicUrl)).status).toBeGreaterThanOrEqual(400);

    // Not a member: cannot download.
    const { data: outsiderFile } = await outsider.storage.from('product-photos').download(path);
    expect(outsiderFile).toBeNull();

    // Packer cannot delete...
    await bucket().remove([path]);
    const { data: stillThere } = await adminClient().storage.from('product-photos').exists(path);
    expect(stillThere).toBe(true);

    // ...the owner can.
    const { data: removed, error: removeError } = await owner.storage
      .from('product-photos')
      .remove([path]);
    expect(removeError).toBeNull();
    expect(removed).toHaveLength(1);
  });

  it('rejects files of the wrong type in product-photos', async () => {
    const { error } = await packer.storage
      .from('product-photos')
      .upload(`test/${uniq('bad')}.pdf`, new Uint8Array([37, 80, 68, 70]), {
        contentType: 'application/pdf',
      });
    expect(error).not.toBeNull();
  });
});

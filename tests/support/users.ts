import type { MemberRole } from '@happyhome/core';
import { adminClient } from './clients';

export interface TestUser {
  email: string;
  password: string;
  displayName: string;
  /** null = has a login but is NOT a member of the shop */
  role: MemberRole | null;
}

export const TEST_USERS = {
  owner: {
    email: 'e2e-owner@example.com',
    password: 'owner-test-password-1',
    displayName: 'Тест Собственик',
    role: 'owner',
  },
  packer: {
    email: 'e2e-packer@example.com',
    password: 'packer-test-password-1',
    displayName: 'Мама',
    role: 'packer',
  },
  outsider: {
    email: 'e2e-outsider@example.com',
    password: 'outsider-test-password-1',
    displayName: 'Outsider',
    role: null,
  },
} as const satisfies Record<string, TestUser>;

export type TestUserName = keyof typeof TEST_USERS;

/** Creates the test logins (or resets their passwords) and their member rows. Idempotent. */
export async function ensureTestUsers(): Promise<Record<TestUserName, string>> {
  const admin = adminClient();
  const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) throw listError;

  const ids = {} as Record<TestUserName, string>;
  for (const [name, user] of Object.entries(TEST_USERS) as [TestUserName, TestUser][]) {
    let id = list.users.find((u) => u.email === user.email)?.id;
    if (id) {
      const { error } = await admin.auth.admin.updateUserById(id, { password: user.password });
      if (error) throw error;
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: user.email,
        password: user.password,
        email_confirm: true,
      });
      if (error) throw error;
      id = data.user.id;
    }
    ids[name] = id;

    if (user.role) {
      const { error } = await admin
        .from('members')
        .upsert(
          { user_id: id, display_name: user.displayName, role: user.role, active: true },
          { onConflict: 'user_id' },
        );
      if (error) throw error;
    } else {
      const { error } = await admin.from('members').delete().eq('user_id', id);
      if (error) throw error;
    }
  }
  return ids;
}

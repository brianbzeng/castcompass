"use client";

import { AccountModal, useAccount } from "./AccountFeature";
import type { FishingSite } from "../types";

export function ProfilePage({ sites }: { sites: FishingSite[] }) {
  const account = useAccount();
  return <AccountModal key={account.user?.id ?? "anonymous"} account={account} sites={sites} standalone />;
}

import type { AccountConfig } from '../../types.js';
import type { TokenProvider } from './provider.js';
import { OAuthProvider } from './oauth-provider.js';
import { ConfigDirProvider } from './configdir-provider.js';
import { KeychainProvider } from './keychain-provider.js';

export * from './provider.js';
export { OAuthProvider } from './oauth-provider.js';
export { ConfigDirProvider } from './configdir-provider.js';
export { KeychainProvider } from './keychain-provider.js';

export interface ProviderOptions {
  /**
   * Whether to hand the OAuth token to the child on file descriptor 3.
   * Learned from persisted state; see OAuthProvider.
   */
  useFdInjection: boolean;
}

/**
 * Provider lookup. Adding a new credential source (an API-key account, a
 * Bedrock profile, a corporate token broker) means implementing `TokenProvider`
 * and adding one case here — nothing else in the pipeline changes.
 */
export function providerFor(account: AccountConfig, options: ProviderOptions): TokenProvider {
  switch (account.provider) {
    case 'oauth':
      return new OAuthProvider(options.useFdInjection);
    case 'configdir':
      return new ConfigDirProvider();
    case 'keychain':
      return new KeychainProvider();
    default: {
      const exhaustive: never = account.provider;
      throw new Error(`unknown provider: ${String(exhaustive)}`);
    }
  }
}

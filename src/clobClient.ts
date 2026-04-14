import { ClobClient, SignatureType } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

let _client: ClobClient | null = null;

export function getClobClient(): ClobClient {
  if (_client) return _client;

  const host       = process.env['CLOB_HOST']       ?? 'https://clob.polymarket.com';
  const privateKey = process.env['WALLET_PRIVATE_KEY'];
  const chainId    = parseInt(process.env['CHAIN_ID'] ?? '137');

  if (!privateKey) throw new Error('WALLET_PRIVATE_KEY is not set in .env');

  const funderAddress = process.env['FUNDER_ADDRESS'];
  if (!funderAddress) throw new Error('FUNDER_ADDRESS is not set in .env');

  const wallet = new Wallet(privateKey);
  _client = new ClobClient(
    host,
    chainId,
    wallet,
    {
      key:        process.env['CLOB_API_KEY']        ?? '',
      secret:     process.env['CLOB_API_SECRET']     ?? '',
      passphrase: process.env['CLOB_API_PASSPHRASE'] ?? '',
    },
    SignatureType.POLY_GNOSIS_SAFE,
    funderAddress,
  );

  return _client;
}

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
const viem = require('../../indexer/node_modules/viem');
const { privateKeyToAccount } = require('../../indexer/node_modules/viem/accounts');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const rpcUrl = process.env.RPC_URL || 'https://testnet-rpc.elysium.kinetiq.xyz';
  const privateKey = process.env.ATTESTER_PRIVATE_KEY;
  const expectedChainId = 99801;

  if (!privateKey) {
    console.error('ERROR: ATTESTER_PRIVATE_KEY environment variable is required for deployment.');
    process.exit(1);
  }

  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(formattedKey);

  const chain = {
    id: expectedChainId,
    name: 'Elysium Testnet',
    nativeCurrency: { name: 'Elysium', symbol: 'ELY', decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
      public: { http: [rpcUrl] },
    },
  };

  const client = viem.createWalletClient({
    account,
    chain,
    transport: viem.http(rpcUrl),
  });

  const publicClient = viem.createPublicClient({
    chain,
    transport: viem.http(rpcUrl),
  });

  const currentChainId = await publicClient.getChainId();
  if (currentChainId !== expectedChainId) {
    console.error(`ERROR: Chain ID mismatch. Expected ${expectedChainId}, got ${currentChainId}.`);
    process.exit(1);
  }

  console.log('Deploying ElysiumAssessmentAttestation to Elysium Testnet...');
  console.log(`Deployer address: ${account.address}`);
  console.log(`Chain ID: ${currentChainId}`);

  const localArtifactPath = join(__dirname, '../artifacts/contracts/ElysiumAssessmentAttestation.sol/ElysiumAssessmentAttestation.json');
  const indexerArtifactPath = join(__dirname, '../../indexer/src/abi/ElysiumAssessmentAttestation.json');
  const artifactPath = existsSync(localArtifactPath) ? localArtifactPath : indexerArtifactPath;
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));

  const hash = await client.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  });

  console.log(`Deployment transaction submitted: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  console.log('====================================');
  console.log('CONTRACT DEPLOYMENT SUCCESSFUL');
  console.log('====================================');
  console.log(`Contract Address: ${receipt.contractAddress}`);
  console.log(`Transaction Hash: ${receipt.transactionHash}`);
  console.log(`Block Number: ${receipt.blockNumber}`);
  console.log(`Deployer: ${account.address}`);
  console.log(`Chain ID: ${currentChainId}`);
  console.log('====================================');
}

main().catch((err) => {
  console.error('Deployment failed:', err.message || err);
  process.exit(1);
});

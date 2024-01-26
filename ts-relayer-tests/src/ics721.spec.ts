import { CosmWasmSigner } from "@confio/relayer";
import anyTest, { ExecutionContext, TestFn } from "ava";
import { Order } from "cosmjs-types/ibc/core/channel/v1/channel";

import { instantiateContract } from "./controller";
import { mint, ownerOf, sendNft } from "./cw721-utils";
import { migrate } from "./ics721-utils";
import {
  assertAckErrors,
  assertAckSuccess,
  bigIntReplacer,
  ChannelAndLinkInfo,
  ContractMsg,
  createIbcConnectionAndChannel,
  MNEMONIC,
  setupOsmosisClient,
  setupWasmClient,
  uploadAndInstantiate,
  uploadAndInstantiateAll,
} from "./utils";

interface TestContext {
  wasmClient: CosmWasmSigner;
  wasmAddr: string;

  osmoClient: CosmWasmSigner;
  osmoAddr: string;

  wasmCw721: string;
  wasmIcs721: string;
  wasmCw721IncomingProxy: string;
  wasmCw721OutgoingProxy: string;

  osmoCw721: string;
  osmoIcs721: string;
  osmoCw721IncomingProxy: string;
  osmoCw721OutgoingProxy: string;

  channel: ChannelAndLinkInfo;
  onlyOsmoIncomingChannel: ChannelAndLinkInfo; // this channel is WLed only in incoming proxy on osmo side
  otherChannel: ChannelAndLinkInfo;
}

const test = anyTest as TestFn<TestContext>;

const WASM_FILE_CW721 = "./internal/cw721_base_v0.18.0.wasm";
const WASM_FILE_CW721_INCOMING_PROXY = "./internal/cw721_incoming_proxy.wasm";
const WASM_FILE_CW721_OUTGOING_PROXY =
  "./internal/cw721_outgoing_proxy_rate_limit.wasm";
const WASM_FILE_CW_ICS721_ICS721 = "./internal/ics721_base.wasm";
const MALICIOUS_CW721 = "./internal/cw721_tester.wasm";

const standardSetup = async (t: ExecutionContext<TestContext>) => {
  t.context.wasmClient = await setupWasmClient(MNEMONIC);
  t.context.osmoClient = await setupOsmosisClient(MNEMONIC);

  t.context.wasmAddr = t.context.wasmClient.senderAddress;
  t.context.osmoAddr = t.context.osmoClient.senderAddress;

  const { wasmClient, osmoClient } = t.context;

  const wasmContracts: Record<string, ContractMsg> = {
    cw721: {
      path: WASM_FILE_CW721,
      instantiateMsg: {
        name: "ark",
        symbol: "ark",
        minter: wasmClient.senderAddress,
      },
    },
    cw721IncomingProxy: {
      path: WASM_FILE_CW721_INCOMING_PROXY,
      instantiateMsg: undefined,
    },
    cw721OutgoingProxy: {
      path: WASM_FILE_CW721_OUTGOING_PROXY,
      instantiateMsg: undefined,
    },
    ics721: {
      path: WASM_FILE_CW_ICS721_ICS721,
      instantiateMsg: undefined,
    },
  };
  const osmoContracts: Record<string, ContractMsg> = {
    cw721: {
      path: WASM_FILE_CW721,
      instantiateMsg: {
        name: "ark",
        symbol: "ark",
        minter: osmoClient.senderAddress,
      },
    },
    cw721IncomingProxy: {
      path: WASM_FILE_CW721_INCOMING_PROXY,
      instantiateMsg: undefined,
    },
    cw721OutgoingProxy: {
      path: WASM_FILE_CW721_OUTGOING_PROXY,
      instantiateMsg: undefined,
    },
    ics721: {
      path: WASM_FILE_CW_ICS721_ICS721,
      instantiateMsg: undefined,
    },
  };

  const info = await uploadAndInstantiateAll(
    wasmClient,
    osmoClient,
    wasmContracts,
    osmoContracts
  );

  const wasmCw721Id = info.wasmContractInfos.cw721.codeId;
  const osmoCw721Id = info.osmoContractInfos.cw721.codeId;

  const wasmCw721IncomingProxyId =
    info.wasmContractInfos.cw721IncomingProxy.codeId;
  const osmoCw721IncomingProxyId =
    info.osmoContractInfos.cw721IncomingProxy.codeId;

  const wasmIcs721Id = info.wasmContractInfos.ics721.codeId;
  const osmoIcs721Id = info.osmoContractInfos.ics721.codeId;

  const wasmCw721OutgoingProxyId =
    info.wasmContractInfos.cw721OutgoingProxy.codeId;
  const osmoCw721OutgoingProxyId =
    info.osmoContractInfos.cw721OutgoingProxy.codeId;

  t.context.wasmCw721 = info.wasmContractInfos.cw721.address as string;
  t.context.osmoCw721 = info.osmoContractInfos.cw721.address as string;

  t.log(`instantiating wasm ICS721 contract (${wasmIcs721Id})`);
  const { contractAddress: wasmIcs721 } = await instantiateContract(
    wasmClient,
    wasmIcs721Id,
    { cw721_base_code_id: wasmCw721Id },
    "label ics721"
  );
  t.log(`- wasm ICS721 contract address: ${wasmIcs721}`);
  t.context.wasmIcs721 = wasmIcs721;

  t.log(`instantiating osmo ICS721 contract (${osmoIcs721Id})`);
  const { contractAddress: osmoIcs721 } = await instantiateContract(
    osmoClient,
    osmoIcs721Id,
    { cw721_base_code_id: osmoCw721Id },
    "label ics721"
  );
  t.log(`- osmo ICS721 contract address: ${osmoIcs721}`);
  t.context.osmoIcs721 = osmoIcs721;

  t.log(
    `creating IBC connection and channel between ${wasmIcs721} <-> ${osmoIcs721}`
  );
  const channelInfo = await createIbcConnectionAndChannel(
    wasmClient,
    osmoClient,
    wasmIcs721,
    osmoIcs721,
    Order.ORDER_UNORDERED,
    "ics721-1"
  );
  t.log(
    `- channel for incoming proxy on both chains: ${JSON.stringify(
      channelInfo.channel,
      bigIntReplacer,
      2
    )}`
  );
  t.context.channel = channelInfo;

  t.log(
    `instantiating wasm cw721-incoming-proxy (${wasmCw721IncomingProxyId}) with channel ${channelInfo.channel.src.channelId}`
  );
  const { contractAddress: wasmCw721IncomingProxy } = await instantiateContract(
    wasmClient,
    wasmCw721IncomingProxyId,
    {
      origin: wasmIcs721,
      channels: [channelInfo.channel.src.channelId],
    },
    "label incoming proxy"
  );
  t.log(`- wasm cw721-incoming-proxy address: ${wasmCw721IncomingProxy}`);
  t.context.wasmCw721IncomingProxy = wasmCw721IncomingProxy;

  t.log(
    `migrate ${wasmIcs721} contract with incoming proxy ${wasmCw721IncomingProxy}`
  );
  await migrate(wasmClient, wasmIcs721, wasmIcs721Id, wasmCw721IncomingProxy);

  const onlyOsmoIncomingChannelInfo = await createIbcConnectionAndChannel(
    wasmClient,
    osmoClient,
    wasmIcs721,
    osmoIcs721,
    Order.ORDER_UNORDERED,
    "ics721-1"
  );
  t.log(
    `- channel for incoming proxy only on wasm chain: ${JSON.stringify(
      onlyOsmoIncomingChannelInfo.channel,
      bigIntReplacer,
      2
    )}`
  );
  t.context.onlyOsmoIncomingChannel = onlyOsmoIncomingChannelInfo;

  t.log(
    `instantiating osmo cw721-incoming-proxy (${osmoCw721IncomingProxyId}) with channel ${channelInfo.channel.dest.channelId}and ${onlyOsmoIncomingChannelInfo.channel.dest.channelId}`
  );
  const { contractAddress: osmoCw721IncomingProxy } = await instantiateContract(
    osmoClient,
    osmoCw721IncomingProxyId,
    {
      origin: osmoIcs721,
      channels: [
        channelInfo.channel.dest.channelId,
        onlyOsmoIncomingChannelInfo.channel.dest.channelId,
      ],
    },
    "label incoming proxy"
  );
  t.log(`- osmo cw721-incoming-proxy address: ${osmoCw721IncomingProxy}`);
  t.context.osmoCw721IncomingProxy = osmoCw721IncomingProxy;

  const per_block = 10; // use high rate limit to avoid test failures
  t.log(
    `instantiating wasm cw721-outgoing-proxy (${wasmCw721OutgoingProxyId}) with ${per_block} per blocks rate limit`
  );
  const { contractAddress: wasmCw721OutgoingProxy } = await instantiateContract(
    wasmClient,
    wasmCw721OutgoingProxyId,
    {
      origin: wasmIcs721,
      rate_limit: { per_block },
    },
    "label outgoing proxy"
  );
  t.log(`- wasm cw721-outgoing-proxy address: ${wasmCw721OutgoingProxy}`);
  t.context.wasmCw721OutgoingProxy = wasmCw721OutgoingProxy;

  t.log(
    `instantiating osmo cw721-outgoing-proxy (${osmoCw721OutgoingProxyId}) with ${per_block} per blocks rate limit`
  );
  const { contractAddress: osmoCw721OutgoingProxy } = await instantiateContract(
    osmoClient,
    osmoCw721OutgoingProxyId,
    {
      origin: osmoIcs721,
      rate_limit: { per_block },
    },
    "label outgoing proxy"
  );
  t.log(`- osmo cw721-outgoing-proxy address: ${osmoCw721OutgoingProxy}`);
  t.context.osmoCw721OutgoingProxy = osmoCw721OutgoingProxy;

  t.log(
    `migrate ${wasmIcs721} contract with incoming (${wasmCw721IncomingProxy}) and outgoing proxy (${wasmCw721OutgoingProxy})`
  );
  await migrate(
    wasmClient,
    wasmIcs721,
    wasmIcs721Id,
    wasmCw721IncomingProxy,
    wasmCw721OutgoingProxy
  );

  t.log(
    `migrate ${osmoIcs721} contract with incoming (${osmoCw721IncomingProxy}) and outgoing proxy (${osmoCw721OutgoingProxy})`
  );
  await migrate(
    osmoClient,
    osmoIcs721,
    osmoIcs721Id,
    osmoCw721IncomingProxy,
    osmoCw721OutgoingProxy
  );

  t.log(
    `creating another IBC connection and channel between wasm and osmo (${wasmIcs721} <-> ${osmoIcs721})`
  );
  const otherChannelInfo = await createIbcConnectionAndChannel(
    wasmClient,
    osmoClient,
    wasmIcs721,
    osmoIcs721,
    Order.ORDER_UNORDERED,
    "ics721-1"
  );
  t.log(
    `- other channel not WLed for incoming proxy: ${JSON.stringify(
      otherChannelInfo.channel,
      bigIntReplacer,
      2
    )}`
  );
  t.context.otherChannel = otherChannelInfo;

  t.pass();
};

test.serial("transfer NFT: wasmd -> osmo", async (t) => {
  await standardSetup(t);

  const {
    wasmClient,
    wasmAddr,
    wasmCw721,
    wasmIcs721,
    wasmCw721OutgoingProxy,
    osmoClient,
    osmoAddr,
    osmoIcs721,
    channel,
    otherChannel,
  } = t.context;

  let tokenId = "1";
  await mint(wasmClient, wasmCw721, tokenId, wasmAddr, undefined);
  // assert token is minted
  let tokenOwner = await ownerOf(wasmClient, wasmCw721, tokenId);
  t.is(wasmAddr, tokenOwner.owner);

  // ==== happy path: transfer NFT to osmo chain and back to wasm chain ====
  // test transfer NFT to osmo chain
  t.log(`transfering to osmo chain via ${channel.channel.src.channelId}`);
  let ibcMsg = {
    receiver: osmoAddr,
    channel_id: channel.channel.src.channelId,
    timeout: {
      block: {
        revision: 1,
        height: 90000,
      },
    },
  };
  let transferResponse = await sendNft(
    wasmClient,
    wasmCw721,
    wasmCw721OutgoingProxy,
    ibcMsg,
    tokenId
  );
  t.truthy(transferResponse);

  // Relay and verify we got a success
  t.log("relaying packets");
  let info = await channel.link.relayAll();
  assertAckSuccess(info.acksFromA);

  // assert NFT on chain A is locked/owned by ICS contract
  tokenOwner = await ownerOf(wasmClient, wasmCw721, tokenId);
  t.is(wasmIcs721, tokenOwner.owner);
  // assert NFT on chain B is owned by osmoAddr
  const osmoClassId = `${channel.channel.dest.portId}/${channel.channel.dest.channelId}/${t.context.wasmCw721}`;
  const osmoCw721 = await osmoClient.sign.queryContractSmart(osmoIcs721, {
    nft_contract: { class_id: osmoClassId },
  });
  tokenOwner = await ownerOf(osmoClient, osmoCw721, tokenId);
  t.is(osmoAddr, tokenOwner.owner);

  // test back transfer NFT to wasm chain
  t.log(`transfering back to wasm chain via ${channel.channel.dest.channelId}`);
  transferResponse = await sendNft(
    osmoClient,
    osmoCw721,
    t.context.osmoCw721OutgoingProxy,
    {
      receiver: wasmAddr,
      channel_id: channel.channel.dest.channelId,
      timeout: {
        block: {
          revision: 1,
          height: 90000,
        },
      },
    },
    tokenId
  );
  t.truthy(transferResponse);
  t.log("relaying packets");

  // Verify we got a success
  info = await channel.link.relayAll();
  assertAckSuccess(info.acksFromA);

  // assert NFT on chain A is returned to owner
  tokenOwner = await ownerOf(wasmClient, wasmCw721, tokenId);
  t.is(wasmAddr, tokenOwner.owner);

  // ==== test transfer NFT to osmo chain via unknown, not WLed channel by incoming proxy ====
  // test rejected NFT transfer due to unknown channel by incoming proxy
  tokenId = "2";
  await mint(wasmClient, wasmCw721, tokenId, wasmAddr, undefined);
  // assert token is minted
  tokenOwner = await ownerOf(wasmClient, wasmCw721, tokenId);
  t.is(wasmAddr, tokenOwner.owner);

  t.log(
    `transfering to osmo chain via unknown ${otherChannel.channel.src.channelId}`
  );
  ibcMsg = {
    receiver: osmoAddr,
    channel_id: otherChannel.channel.src.channelId,
    timeout: {
      block: {
        revision: 1,
        height: 90000,
      },
    },
  };
  transferResponse = await sendNft(
    wasmClient,
    wasmCw721,
    wasmCw721OutgoingProxy,
    ibcMsg,
    tokenId
  );
  t.truthy(transferResponse);

  // Relay and verify we got an error
  t.log("relaying packets");
  info = await otherChannel.link.relayAll();
  assertAckErrors(info.acksFromA);

  // assert NFT on chain A is returned to owner
  tokenOwner = await ownerOf(wasmClient, wasmCw721, tokenId);
  t.is(wasmAddr, tokenOwner.owner);

  // ==== test transfer NFT to osmo chain via channel WLed ONLY osmo incoming proxy and back to wasm chain ====
});

test.serial("malicious NFT", async (t) => {
  await standardSetup(t);
  const {
    wasmClient,
    wasmAddr,
    wasmIcs721,
    wasmCw721OutgoingProxy,
    osmoClient,
    osmoAddr,
    osmoIcs721,
    osmoCw721OutgoingProxy,
    channel,
  } = t.context;
  const tokenId = "1";

  // instantiate malicious cw721 contract
  const res = await uploadAndInstantiate(wasmClient, {
    cw721_gas_tester: {
      path: MALICIOUS_CW721,
      instantiateMsg: {
        name: "evil",
        symbol: "evil",
        minter: wasmClient.senderAddress,
        banned_recipient: "banned_recipient", // panic every time, on back transfer, when ICS721 tries to transfer/unescrow NFT to this address
      },
    },
  });
  const cw721 = res.cw721_gas_tester.address as string;

  // ==== test malicious NFT transfer to osmo chain ====
  await mint(wasmClient, cw721, tokenId, wasmAddr, undefined);
  t.log("transferring to osmo chain");
  let ibcMsg = {
    receiver: osmoAddr,
    channel_id: channel.channel.src.channelId,
    timeout: {
      block: {
        revision: 1,
        height: 90000,
      },
    },
  };
  let transferResponse = await sendNft(
    wasmClient,
    cw721,
    wasmCw721OutgoingProxy,
    ibcMsg,
    tokenId
  );
  t.truthy(transferResponse);

  t.log("relaying packets");
  let info = await channel.link.relayAll();
  assertAckSuccess(info.acksFromB);

  // assert NFT on chain A is locked/owned by ICS contract
  let tokenOwner = await ownerOf(wasmClient, cw721, tokenId);
  t.is(wasmIcs721, tokenOwner.owner);
  // assert NFT on chain B is owned by osmoAddr
  const osmoClassId = `${t.context.channel.channel.dest.portId}/${t.context.channel.channel.dest.channelId}/${cw721}`;
  const osmoCw721 = await osmoClient.sign.queryContractSmart(osmoIcs721, {
    nft_contract: { class_id: osmoClassId },
  });
  tokenOwner = await ownerOf(osmoClient, osmoCw721, tokenId);
  t.is(osmoAddr, tokenOwner.owner);

  // ==== test malicious NFT back transfer to banned recipient on wasm chain ====
  t.log("transferring back to wasm chain to banned recipient");
  ibcMsg = {
    receiver: "banned_recipient",
    channel_id: channel.channel.dest.channelId,
    timeout: {
      block: {
        revision: 1,
        height: 90000,
      },
    },
  };
  transferResponse = await sendNft(
    osmoClient,
    osmoCw721,
    osmoCw721OutgoingProxy,
    ibcMsg,
    tokenId
  );
  t.truthy(transferResponse);
  // before relay NFT escrowed by ICS721
  tokenOwner = await ownerOf(osmoClient, osmoCw721, tokenId);
  t.is(osmoIcs721, tokenOwner.owner);

  t.log("relaying packets");
  let pending = await channel.link.getPendingPackets("B");
  t.is(pending.length, 1);
  // Despite the transfer panicking, a fail ack should be returned.
  info = await channel.link.relayAll();
  assertAckErrors(info.acksFromA);
  // assert after failed relay, NFT on chain B is returned to owner
  tokenOwner = await ownerOf(osmoClient, osmoCw721, tokenId);
  t.is(osmoAddr, tokenOwner.owner);
  t.log(`NFT #${tokenId} returned to owner`);

  // ==== test malicious NFT transfer to regular recipient wasm chain ====
  t.log("transferring back to wasm chain to recipient", wasmAddr);
  ibcMsg = {
    receiver: wasmAddr,
    channel_id: channel.channel.dest.channelId,
    timeout: {
      block: {
        revision: 1,
        height: 90000,
      },
    },
  };

  transferResponse = await sendNft(
    osmoClient,
    osmoCw721,
    osmoCw721OutgoingProxy,
    ibcMsg,
    tokenId
  );
  t.truthy(transferResponse);

  // Relay and verify we got a success
  t.log("relaying packets");
  pending = await channel.link.getPendingPackets("B");
  t.is(pending.length, 1);
  info = await channel.link.relayAll();
  assertAckSuccess(info.acksFromB);

  // assert NFT on chain A is returned to owner
  tokenOwner = await ownerOf(wasmClient, cw721, tokenId);
  t.is(wasmAddr, tokenOwner.owner);
});

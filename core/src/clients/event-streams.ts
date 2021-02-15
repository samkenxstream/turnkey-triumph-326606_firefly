import WebSocket from 'ws';
import { config } from '../lib/config';
import * as utils from '../lib/utils';
import { IDBBlockchainData, IEventAssetDefinitionCreated, IEventAssetInstanceBatchCreated, IEventAssetInstanceCreated, IEventAssetInstancePropertySet, IEventPaymentDefinitionCreated, IEventPaymentInstanceCreated, IEventStreamMessage, IEventStreamRawMessageCorda } from '../lib/interfaces';
import * as membersHandler from '../handlers/members';
import * as assetDefinitionsHandler from '../handlers/asset-definitions';
import * as paymentDefinitionsHandler from '../handlers/payment-definitions';
import * as assetInstancesHandler from '../handlers/asset-instances';
import * as paymentInstanceHandler from '../handlers/payment-instances';
import { IEventMemberRegistered } from '../lib/interfaces';
import { createLogger, LogLevelString } from 'bunyan';

const log = createLogger({ name: 'clients/event-streams.ts', level: utils.constants.LOG_LEVEL as LogLevelString });

let ws: WebSocket;
let heartBeatTimeout: NodeJS.Timeout;
let disconnectionDetected = false;
let disconnectionTimeout: NodeJS.Timeout;

export const init = () => {
  ws = new WebSocket(config.eventStreams.wsEndpoint, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${config.ledgerAppCredentials.user}:${config.ledgerAppCredentials.password}`).toString('base64')
    }
  });
  addEventHandlers();
};

export const shutDown = () => {
  if (disconnectionTimeout) {
    clearTimeout(disconnectionTimeout);
  }
  if (ws) {
    clearTimeout(heartBeatTimeout);
    ws.close();
  }
};

const addEventHandlers = () => {
  ws.on('open', () => {
    if (disconnectionDetected) {
      disconnectionDetected = false;
      log.info('Event stream websocket restored');
    }
    ws.send(JSON.stringify({
      type: 'listen',
      topic: config.eventStreams.topic
    }));
    heartBeat();
  }).on('close', () => {
    disconnectionDetected = true;
    log.error(`Event stream websocket disconnected, attempting to reconnect in ${utils.constants.EVENT_STREAM_WEBSOCKET_RECONNECTION_DELAY_SECONDS} second(s)`);
    disconnectionTimeout = setTimeout(() => {
      init();
    }, utils.constants.EVENT_STREAM_WEBSOCKET_RECONNECTION_DELAY_SECONDS * 1000);
  }).on('message', async (message: string) => {
    await handleMessage(message);
    ws.send(JSON.stringify({
      type: 'ack',
      topic: config.eventStreams.topic
    }));
  }).on('pong', () => {
    heartBeat();
  }).on('error', err => {
    log.error(`Event stream websocket error. ${err}`);
  });
};

const heartBeat = () => {
  ws.ping();
  clearTimeout(heartBeatTimeout);
  heartBeatTimeout = setTimeout(() => {
    log.error('Event stream ping timeout');
    ws.terminate();
  }, utils.constants.EVENT_STREAM_PING_TIMEOUT_SECONDS * 1000);
}

const processRawMessage = (message: string) => {
  var processedMessages: Array<IEventStreamMessage>;
  switch(config.protocol) {
    case 'ethereum':
      processedMessages = JSON.parse(message);
      break;
    case 'corda':
      const cordaMessages: Array<IEventStreamRawMessageCorda> = JSON.parse(message);
      processedMessages = cordaMessages.map(msg => {
        var processedMessage: IEventStreamMessage = {
          data: {
            ...msg.data.data,
            timestamp: Date.parse(msg.recordedTime)
          },
          transactionHash: msg.stateRef.txhash,
          subId: msg.subId,
          signature: msg.signature
          };
        return processedMessage
      }) 
      break;
  }
  return processedMessages;
}

const getBlockchainData = (message: IEventStreamMessage) => {
  var blockchainData: IDBBlockchainData;
  switch(config.protocol) {
    case 'ethereum': 
      blockchainData = {
        blockNumber: Number(message.blockNumber),
        transactionHash: message.transactionHash
      }
      break;
    case 'corda': {
      blockchainData = {
        transactionHash: message.transactionHash
      }
      break;
    }
  }
  return blockchainData;
}

const eventSignature = () => {
  var signatures;
  switch(config.protocol) {
    case 'ethereum': 
    signatures = utils.contractEventSignatures
      break;
    case 'corda': 
      signatures = utils.contractEventSignaturesCorda
      break;
    }
  return signatures;
} 

const handleMessage = async (message: string) => {
  const messageArray: Array<IEventStreamMessage> = processRawMessage(message);
  log.info(`Event batch (${messageArray.length})`)
  for (const message of messageArray) {
    log.trace(`Event ${JSON.stringify(message)}`);
    const blockchainData: IDBBlockchainData = getBlockchainData(message);
    try {
      switch (message.signature) {
        case eventSignature().MEMBER_REGISTERED:
          await membersHandler.handleMemberRegisteredEvent(message.data as IEventMemberRegistered, blockchainData); break;
        case eventSignature().ASSET_DEFINITION_CREATED:
          await assetDefinitionsHandler.handleAssetDefinitionCreatedEvent(message.data as IEventAssetDefinitionCreated, blockchainData); break;
        case eventSignature().DESCRIBED_PAYMENT_DEFINITION_CREATED:
        case eventSignature().PAYMENT_DEFINITION_CREATED:
          await paymentDefinitionsHandler.handlePaymentDefinitionCreatedEvent(message.data as IEventPaymentDefinitionCreated, blockchainData); break;
        case eventSignature().ASSET_INSTANCE_CREATED:
        case eventSignature().DESCRIBED_ASSET_INSTANCE_CREATED:
          await assetInstancesHandler.handleAssetInstanceCreatedEvent(message.data as IEventAssetInstanceCreated, blockchainData); break;
        case eventSignature().ASSET_INSTANCE_BATCH_CREATED:
          await assetInstancesHandler.handleAssetInstanceBatchCreatedEvent(message.data as IEventAssetInstanceBatchCreated, blockchainData); break;
        case eventSignature().DESCRIBED_PAYMENT_INSTANCE_CREATED:
        case eventSignature().PAYMENT_INSTANCE_CREATED:
          await paymentInstanceHandler.handlePaymentInstanceCreatedEvent(message.data as IEventPaymentInstanceCreated, blockchainData); break;
        case eventSignature().ASSET_PROPERTY_SET:
          await assetInstancesHandler.handleSetAssetInstancePropertyEvent(message.data as IEventAssetInstancePropertySet, blockchainData); break;
      }
    } catch (err) {
      log.error(`Failed to handle event: ${message.signature} for message: ${JSON.stringify(message)} with error`, err.stack);
    }
  }
};
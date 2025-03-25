import shutdownTelemetry from "./telemetry/initialize";

import express = require("express");
import * as http from "http";
import { JinagaServer } from "jinaga-server";
import { authenticate, loadAuthenticationConfigurations } from "./authenticate";
import { findUpstreamReplicators } from "./findUpstreamReplicators";
import { loadPolicies } from "./loadPolicies";
import { loadSubscriptions, runSubscriptions } from "./subscriptions";
import { startTracer } from "./telemetry/tracer";
import process = require("process");
import { Trace } from "jinaga";

startTracer();

process.on('SIGINT', async () => {
  console.log("\n\nStopping replicator\n");
  await shutdownTelemetry();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log("\n\nStopping replicator\n");
  await shutdownTelemetry();
  process.exit(0);
});

const app = express();
const server = http.createServer(app);

server.on('clientError', (err: Error & { code?: string }, socket) => {
  if (err.code === 'ECONNRESET') {
    // Connection reset by peer, just end the socket gracefully.
    Trace.warn('Client error, ECONNRESET');
    socket.end();
  } else {
    // For other errors, send a generic bad request response.
    Trace.warn('Client error, bad request');
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});
process.on('unhandledRejection', (reason, promise) => {
  Trace.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

app.set('port', process.env.PORT || 8080);
app.use(express.json());
app.use(express.text());

async function initializeReplicator() {
  const pgConnection = process.env.JINAGA_POSTGRESQL ||
    'postgresql://repl:replpw@localhost:5432/replicator';
  const policiesPath = process.env.JINAGA_POLICIES || 'policies';
  const authenticationPath = process.env.JINAGA_AUTHENTICATION || 'authentication';
  const subscriptionPath = process.env.JINAGA_SUBSCRIPTIONS || 'subscriptions';
  const ruleSet = await loadPolicies(policiesPath);
  const { configs, allowAnonymous } = await loadAuthenticationConfigurations(authenticationPath);
  const subscriptions = await loadSubscriptions(subscriptionPath);

  const upstreamReplicators = findUpstreamReplicators();

  const { handler, factManager } = JinagaServer.create({
    pgStore: pgConnection,
    pgKeystore: pgConnection,
    upstreamReplicators: upstreamReplicators,
    authorization: ruleSet ? a => ruleSet.authorizationRules : undefined,
    distribution: ruleSet ? d => ruleSet.distributionRules : undefined,
    purgeConditions: ruleSet ? p => ruleSet.purgeConditions : undefined
  });

  app.use('/jinaga', authenticate(configs, allowAnonymous), handler);

  server.listen(app.get('port'), () => {
    runSubscriptions(subscriptions, factManager);
    printLogo();
    console.log(`  Replicator is running at http://localhost:${app.get('port')} in ${app.get('env')} mode`);
    console.log('  Press CTRL-C to stop\n');
  });
}

initializeReplicator()
  .catch((error) => {
    printError();
    console.error("Error initializing replicator.", error);
  });

function printLogo() {
  console.log(`
        *****************************            
     *** *******                     *****       
   **  ***                                ***    
 **    **                                    **  
 *     *                                      ** 
**     **               *******************    * 
**      **       ***********              ***  **
**      ***   **            *****           ** **
 **      ***  **                 *          ** * 
 **        ** **                **          **** 
  **        *****               **         ****  
   **        *****              *          ***   
    **         ***            **          ***    
     **          **         ****         **      
      **           **      ****         **       
       **           ***  **  *         **        
        **            ***   **        **         
          **               **        **          
          ***             **        **           
          ****           **        **            
           *****       ***        **             
             ***********        **               
              *** ***         **                 
                 ***       ***                   
                    *******                      
`);
}

function printError() {
  console.log(`
                   *********                     
                ***         ***                  
              **               **                
            ***                  **              
           ****                   **             
          ****                     **            
          ***          ****          *           
         **           ******          *          
        **            ******           *         
       **             ******           **        
      *               ******            **       
    **                *****              **      
   **                 *****               ***    
   *                   ****                ***   
  **                   ***                  ***  
 **                    **                    *** 
 *                                             * 
**                    ****                     **
**                   ******                    **
**                    *****                    * 
 **                                           ** 
  *                                         ***  
   **                                     ***    
      ***   ******                  *****        
          ********* **************               
`);
}

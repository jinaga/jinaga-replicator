import express = require("express");
import * as http from "http";
import { JinagaServer } from "jinaga-server";
import process = require("process");
import { loadPolicies } from "./loadPolicies";
import { authenticate, loadAuthenticationConfigurations } from "./authenticate";

process.on('SIGINT', () => {
  console.log("\n\nStopping replicator\n");
  process.exit(0);
});

const app = express();
const server = http.createServer(app);

app.set('port', process.env.PORT || 8080);
app.use(express.json());
app.use(express.text());

async function initializeReplicator() {
  const pgConnection = process.env.JINAGA_POSTGRESQL ||
    'postgresql://repl:replpw@localhost:5432/replicator';
  const policiesPath = process.env.JINAGA_POLICIES || 'policies';
  const authenticationPath = process.env.JINAGA_AUTHENTICATION || 'authentication';
  const ruleSet = await loadPolicies(policiesPath);
  const { configs, allowAnonymous } = await loadAuthenticationConfigurations(authenticationPath);
  const { handler } = JinagaServer.create({
    pgStore: pgConnection,
    authorization: ruleSet ? a => ruleSet.authorizationRules : undefined,
    distribution: ruleSet ? d => ruleSet.distributionRules : undefined,
    purgeConditions: ruleSet ? p => ruleSet.purgeConditions : undefined
  });

  app.use('/jinaga', authenticate(configs, allowAnonymous), handler);

  server.listen(app.get('port'), () => {
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
//--------Dependencies-------//
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
var serviceAccount = require("./runningdinnersms-firebase-adminsdk-vd0pu-734a84c2a5.json");


//--------Initialization--------//
const app = express()
const accessTokenSecret = 'carloebbasta';
const refreshTokenSecret = 'refreshcarloebbasta';
const H24 = 86400; // Indica i secondi in un giorno

// Elenco di refresh tokens contenenti quelli validi. Dal momento che il refresh token
// non scade mai (per non sbattere mai fuori gli utenti), scelto per ora di mantenere 
// la struttura in memoria, che quindi non sopravvive al riavvio del server, 
// il quale sbatte fuori tutti 
const refreshTokens = [];

app.use(bodyParser.json({ limit: '50mb' })); // Configurato per rimuovere il limite di dimensioni del pacchetto http che impediva la registrazione utente
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors()) // Utilizzo libreria CORS per configurare domini da cui ricevere chiamata (nel caso dell'app devo impostare ALL)

// Configurazione Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://runningdinnersms.firebaseio.com"
});

console.warn("App Avviata: versione " + process.env.VERSION);

// Authorization Middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
    const token = authHeader.split(' ')[1];

    jwt.verify(token, accessTokenSecret, (err, user) => {
      if (err) {
        // Token non valido o scaduto, ritorno unauthorized
        return res.status(401).send('Invalid token');
      }

      req.user = user; // Imposto lo user nelle chiamate autenticate in modo che gli endpoint lo abbiano a disposizione
      next();
    });
  } else {
    res.status(401).send('No authorization header');
  }
};

// Funzione che esegue la rollback di una transazione
const rollback = function (pool, response, err) { // Funzione che esegue la rollback dall'ultima begin
  console.log(err);
  pool.query('ROLLBACK', function () {
    response.status(500).json({ message: 'errore query, fatto rollback' })
  });
};

//--------Routes Functions-------//

const getUsers = (request, response) => {
  pool.query('SELECT * FROM users', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).json(results.rows)
    }
  })
};

const addUser = (request, response) => {
  const { name, address, phoneNumber, birthDate, profilePhoto } = request.body

  console.log("Inserimento nuovo utente: " + request.body.name);

  pool.query('INSERT INTO users (name, address, phone_number, birth_date, profile_photo, created_on) VALUES ($1, $2, $3, $4, $5, $6)', [name, address, phoneNumber, birthDate, profilePhoto, new Date()], error => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(201).json({ status: 'success', message: 'User added.' })
    }
  })
};

const checkUserExists = (request, response) => {
  const { phone_number } = request.body;

  pool.query('SELECT count(*) FROM users WHERE phone_number =\'' + phone_number + '\'', (error, results) => {
    if (error) {
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).json(results.rows[0].count == 1)
    }
  })
};

const updateUser = (req, res) => {
  const { user } = req.body;
  pool.query('SELECT * FROM users WHERE phone_number =\'' + user.phone_number + '\'', (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query' })
    } else {
      // Aggiorno le informazioni dell'utente
      pool.query('UPDATE users SET name = $1 WHERE phone_number = $2', [user.name, user.phone_number], (error, results) => {
        if (error) {
          console.warn(error);
          res.status(500).json({ message: 'errore query update name' });
        } else {
          pool.query('UPDATE users SET address = $1 WHERE phone_number = $2', [user.address, user.phone_number], (error, results) => {
            if (error) {
              console.warn(error);
              res.status(500).json({ message: 'errore query update address' });
            } else {
              pool.query('UPDATE users SET birth_date = $1 WHERE phone_number = $2', [user.birth_date, user.phone_number], (error, results) => {
                if (error) {
                  console.warn(error);
                  res.status(500).json({ message: 'errore query update birth_date' });
                } else {
                  // Genero le informazioni di sessione memorizzate nel token (rimuovo profile_photo)
                  const userData = {
                    userid: user.userid,
                    name: user.name,
                    address: user.address,
                    phone_number: user.phone_number,
                    birth_date: user.birth_date,
                    refreshedOn: new Date()
                  };

                  // Genero access token e refresh token, impostando la durata a un giorno
                  const accessToken = jwt.sign(userData, accessTokenSecret, { expiresIn: H24 });
                  const refreshToken = jwt.sign(userData, refreshTokenSecret);
                  refreshTokens.push(refreshToken); // Aggiungo il refreshToken alla lista in memoria, non sopravvive a riavvio server

                  // Risposta contenente dati utente
                  res.json({
                    accessToken: accessToken,
                    refreshToken: refreshToken,
                    userData: user
                  });
                }
              })
            }
          })
        }
      })
    }
  })
}

const login = (req, res) => {
  const { phone_number } = req.body;

  console.warn('Login: ' + JSON.stringify(req.body));

  pool.query('SELECT * FROM users WHERE phone_number =\'' + phone_number + '\'', (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query' })
    } else {
      user = results.rows[0];
      if (user) {
        // Aggiorno le informazioni sull'ultimo accesso dell'utente
        pool.query('UPDATE users SET last_login = $1 WHERE phone_number = $2', [new Date(), phone_number], (error, results) => {
          if (error) {
            console.warn(error);
            res.status(500).json({ message: 'errore query update last_login' });
          } else {
            // Genero le informazioni di sessione memorizzate nel token (rimuovo profile_photo)
            const userData = {
              userid: user.userid,
              name: user.name,
              address: user.address,
              phone_number: user.phone_number,
              birth_date: user.birth_date,
              refreshedOn: new Date()
            };
            // Genero access token e refresh token, impostando la durata a un giorno
            const accessToken = jwt.sign(userData, accessTokenSecret, { expiresIn: H24 });
            const refreshToken = jwt.sign(userData, refreshTokenSecret);
            refreshTokens.push(refreshToken); // Aggiungo il refreshToken alla lista in memoria, non sopravvive a riavvio server

            // Risposta contenente token e dati utente
            res.json({
              accessToken: accessToken,
              refreshToken: refreshToken,
              userData: user
            });
          }
        });
      } else {
        res.send('Incorrect credentials o.O');
      }
    }
  })
};

const logout = (request, response) => {
  const { userId } = request.body;

  console.warn('Logout: ' + userId);

  pool.query('UPDATE users SET firebase_token = NULL WHERE userid = ' + userId , (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      response.status(200).send();
    }
  })
};

const refreshToken = (req, res) => {
  const refreshToken = req.body.refreshToken;

  if (!refreshTokens.includes(refreshToken)) {
    return res.status(404).send('Refresh token not found (server riavviato)');
  }

  // Verifico refresh token
  jwt.verify(refreshToken, refreshTokenSecret, (err, user) => {
    if (err) {
      return res.status(401).send('Invalid refresh token');
    }

    // Creo il nuovo access token modificando il valore refreshedOn per generarne uno
    // diverso, altrimenti la funzione 'sign' genererebbe lo stesso di prima già scaduto
    // Inoltre aumentata leggermente validità altrimenti per qualche motivo utilizzandolo
    // nasce scaduto
    user.refreshedOn = new Date();
    const newAccessToken = jwt.sign(user, accessTokenSecret, { expiresIn: H24 + 100 });

    res.json({
      accessToken: newAccessToken
    });
  });
};

const updateFirebaseToken = (request, response) => {
  const { firebaseToken } = request.body;

  console.warn("UpdateToken for user: " + request.user.userid);

  // Valorizzo (o aggiorno) il token assegnato all'utente
  pool.query('UPDATE users SET firebase_token = $1 WHERE userid = $2', [firebaseToken, request.user.userid], (error, results) => {
    if (error) {
      console.warn(error);
      res.status(500).json({ message: 'errore query update firebase token' });
    } else {
      response.status(200).send();
    }
  });
};

const getParams = (request, response) => {
  const rdParams = {
    groupId: 0 // Valorizzo di base il groupId per evitare errori in query successive
  };

  console.log("GetParams - User: " + request.user.userid);

  // 1 - GroupId
  pool.query('SELECT * FROM groups_users WHERE userid = ' + request.user.userid,
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) {
          // Scelto di selezionare il primo gruppo a cui fa parte l'utente, anche se teoricamente non
          // può far parte di più gruppi contemporaneamente
          rdParams.groupId = results.rows[0]['groupid'];
        }

        // 2 - DinnerId
        pool.query('SELECT * FROM dinners_detgroups WHERE groupid = ' + rdParams.groupId,
          (error, results) => {
            if (error) {
              console.warn(error);
              response.status(500).json({ message: 'errore query' })
            } else {
              if (results.rows.length > 0) {
                // Scelto di selezionare la prima cena a cui fa parte l'utente, anche se teoricamente non
                // può far parte di più cene contemporaneamente
                rdParams.dinnerId = results.rows[0]['dinnerid'];
              }

              // Ritorno i parametri dell'utente
              response.status(200).json(rdParams);
            }
          });
      }
    });
};

const compareContacts = (request, response) => {
  const localContacts = request.body;
  const resContacts = [];

  console.log("CompareContacts - User: " + request.user.userid);

  if (localContacts.length > 0) {
    pool.query('SELECT * FROM users', (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        const dbContacts = results.rows;
        for (var i = 0; i < localContacts.length; i++) { // Per ogni utente su App
          for (var j = 0; j < dbContacts.length; j++) { // Per ogni utente su DB
            for (var x = 0; x < localContacts[i].phoneNumbers.length; x++) { // Per ogni numero di telefono
              if (localContacts[i].phoneNumbers[x] === dbContacts[j].phone_number &&
                !resContacts.find(contact => contact.phoneNumbers === localContacts[i].phoneNumbers[x])) { // Match e controllo se esiste già quel numero
                resContacts.push({
                  phoneNumbers: localContacts[i].phoneNumbers[x],
                  imageUrl: dbContacts[j].profile_photo,
                  userId: dbContacts[j].userid
                });
              }
            }
          }
        }
        response.status(200).json(resContacts);
      }
    });
  } else {
    console.warn('Ricevuto array di contatti vuoto');
    response.status(200).json(resContacts);
  }
};

const inviteGroup = (request, response) => {
  const { userId: userIdToInvite } = request.body;

  console.warn("InviteGroup: " + userIdToInvite);

  pool.query('SELECT count(*) FROM groups_users WHERE userid = ' + userIdToInvite, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {

      if (parseInt(results.rows[0]['count']) >= 1) {
        response.status(400).json({ message: 'userId ' + userIdToInvite + ' già presente in un gruppo' })
      } else {
        /* const sessionUserId = request.user.userid; // Ottengo lo userId dell'utente loggato dalla sessione
        const groupId = '' + sessionUserId + userIdToInvite; // Genero un groupId concatenando gli userId dei partecipanti

        pool.query('BEGIN', function (err) {
          if (err) return rollback(pool, response, err);
          pool.query('INSERT INTO groups_users (groupid, userid) VALUES ($1, $2)',
            [groupId, sessionUserId], (err) => {
              if (err) return rollback(pool, response, err);
              pool.query('INSERT INTO groups_users (groupid, userid) VALUES ($1, $2)',
                [groupId, userIdToInvite], (err) => {
                  if (err) return rollback(pool, response, err);

                  pool.query('COMMIT', function () {
                    response.status(200).send();
                  });
                });
            });
        }); */

        // Ottengo il token dell'utente che voglio invitare
        pool.query('SELECT * FROM users WHERE userid = ' + userIdToInvite, (error, results) => {
          if (error) {
            console.log(error);
            response.status(500).json({ message: 'errore query' })
          } else {
            const userToken = results.rows[0]['firebase_token'];
            if (!userToken) {
              console.warn('Utente non abilitato a ricevere notifiche push');
              response.status(400).json("Utente non abilitato a ricevere notifiche push");
            } else {
              const message = {
                data: {
                  msg: "Prima notifica!"
                },
                token: userToken
              };

              // Invio notifica di aggiunta a gruppo
              admin.messaging().send(message)
                .then((firebaseResponse) => {
                  console.log('Invito a gruppo inviato con successo');
                  response.status(200).send();
                })
                .catch((error) => {
                  console.log('Errore invito a gruppo:', error);
                });
            }
          }
        });
      }
    }
  });
};

const leaveGroup = (request, response) => {
  const { groupId } = request.body;
  const userId = request.user.userid;

  console.warn("LeaveGroup: " + groupId);

  // Cancello tutte le entries che hanno il mio gruppo di appartenenza, e anche quelle
  // in cui è presente il mio utente in modo da pulire il DB in caso per errore faccia parte
  // di più gruppi contemporaneamente
  pool.query('DELETE FROM groups_users WHERE groupid = ' + groupId + ' OR userid = ' + userId,
    (error, results) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        response.status(200).send();
      }
    });
};

const getDinners = (request, response) => {
  //TODO
};

const createDinner = (request, response) => {
  const { dinnerDescription, dinnerType, dinnerDate, groupId } = request.body;
  const createdBy = request.user.userid; // Ottengo lo userId dell'utente loggato dalla sessione
  const dinnerId = Math.floor(Math.random() * (100000 - 1)) + 1; // Genero dinnerId random per averlo subito invece che farlo generare al DB

  console.log("Crate dinner - dinnerId: " + dinnerId);

  // Gestione inserimento doppio in transazione con eventuale rollback se qualcosa fallisce
  pool.query('BEGIN', function (err) {
    if (err) {
      return rollback(pool, response, err);
    }
    // Creo la cena
    pool.query('INSERT INTO dinners (dinnerid, dinner_type, dinner_date, dinner_description, created_by) VALUES ($1, $2, $3, $4, $5)',
      [dinnerId, dinnerType, dinnerDate, dinnerDescription, createdBy], (err) => {
        if (err) return rollback(pool, response, err);

        // Aggiungo il gruppo come primo partecipante della cena
        pool.query('INSERT INTO dinners_detgroups (dinnerid, groupid) VALUES ($1, $2)',
          [dinnerId, groupId], (err) => {
            if (err) return rollback(pool, response, err);

            pool.query('COMMIT', function () {
              response.status(201).send();
            });
          });
      });
  });
};

const runQuery = (request, response) => {
  const query = request.body.query;

  console.warn("RunQuery: " + query);

  if (query) {
    pool.query(query, (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.warn("Results: " + JSON.stringify(results.rows));
        response.status(200).json(results.rows);
      }
    }
    );
  } else {
    console.warn('Empty query');
    response.status(400).json("Empty query");
  }
};

//--------Routes Definition-------//

//Users
app
  .route('/users')
  .get(authenticateJWT, getUsers) //[Non utilizzare] GET endpoint to list Users
  .post(addUser) // POST endpoint to signup user

//UpdateUser
app
  .route('/updateUser')
  .post(updateUser) //POST endpoint to update user

//ExistsUser
app
  .route('/existsUser')
  .post(checkUserExists)

//Login
app.post('/login', login);

//Logout
app
  .route('/logout')
  .post(logout)

//RefreshToken
app.post('/refreshToken', refreshToken);

//Params
app
  .route('/params')
  .get(authenticateJWT, getParams)

//CompareContacts
app
  .route('/compareContacts')
  .post(authenticateJWT, compareContacts);

//InviteGroup
app
  .route('/inviteGroup')
  .post(authenticateJWT, inviteGroup);

//LeaveGroup
app
  .route('/leaveGroup')
  .post(authenticateJWT, leaveGroup);

//UpdateFirebaseToken
app
  .route('/updateFirebaseToken')
  .post(authenticateJWT, updateFirebaseToken);

//Dinners
app
  .route('/dinners')
  .get(authenticateJWT, getDinners)
  .post(authenticateJWT, createDinner)

//RunQuery
app
  .route('/runQuery')
  .post(authenticateJWT, runQuery);

//--------Run--------//

// Start Server
app.listen(process.env.PORT || 1111, () => {
  console.log(`Server listening`)
})
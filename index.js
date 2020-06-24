//--------Dependencies-------//

const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const serviceAccount = require("./runningdinnersms-firebase-adminsdk-vd0pu-075efce3ba.json");
const { Client, Status } = require("@googlemaps/google-maps-services-js");

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

//--------Utility Functions-------//

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
    response.status(500).json({ message: 'errore durante il rollback' })
  });
};

// Funzione che invia una notifica push
const sendNotification = function (userToken, notificationTitle, notificationBody, notificationData) {
  // Genero le informazioni da inviare nella notifica
  const notificationMsg = {
    data: {
      msg: JSON.stringify(notificationData)
    },
    notification: {
      title: notificationTitle,
      body: notificationBody,
    },
    android: { // Imposto di suonare su Android
      notification: {
        sound: "default"
      }
    },
    token: userToken
  };

  // Invio notifica tramite Firebase Admin
  admin.messaging().send(notificationMsg)
    .then((firebaseResponse) => {
      console.log('Notifica inviata con successo');
    })
    .catch((error) => {
      console.log('Errore invio notifica:', error);
    });
};

// Funzione che calcola la distanza media tra gli utenti partecipanti alla cena e lo user
const calcDistance = function (results, dinnerUserIds, userId, userAddress) {
  var origin;
  var index;
  var avgDistance;

  /* Controllo se lo user fa parte della cena (myDinner) o meno (otherDinners) ed imposto l'origine del percorso:
  - Primo utente dell'array nel caso di myDinner
  - userAddress nel caso di otherDinners */
  if (dinnerUserIds.includes(userId) === true) {
    origin = results[0].address;
    index = 1;
  } else {
    origin = userAddress;
    index = 0;
  }

  /* Imposto le tappe del percorso calcolato:
  - Tutti gli utenti meno il primo nel caso di myDinner
  - Tutti gli utenti nel caso di otherDinners */
  const waypoints = [];
  for (let i = index; i < results.length; i++) {
    waypoints.push(results[i].address)
  }
  return new Promise(function (resolve, reject) {
    const client = new Client({});
    client
      .directions({
        params: {
          origin: origin,
          destination: origin,
          waypoints: waypoints,
          key: "AIzaSyD18at-7iHsmjzYgGyAIrvysftwnkyK12o"
        },
        timeout: 1000,
      })
      .then((r) => {
        var distance = 0;
        // Calcolo la distanza totale del percorso eliminando "km" che la API restituisce in automatico
        for (let k = 0; k < r.data.routes[0].legs.length; k++) {
          r.data.routes[0].legs[k].distance.text = r.data.routes[0].legs[k].distance.text.match(/\d+/)[0]
          distance = distance + Number(r.data.routes[0].legs[k].distance.text)
        };

        // Calcolo la distanza media
        if (index === 1) {
          avgDistance = Math.round(distance / results.length)
        } else {
          avgDistance = Math.round(distance / (results.length + 1))
        }
        resolve(avgDistance)
      })
      .catch((e) => {
        console.log('Richiesta fallita, errore: ' + e);
        reject()
      });
  });
}

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
  // Aggiorno informazioni dell'utente
  pool.query('UPDATE users SET name = $1, address = $2, birth_date = $3, profile_photo = $4 WHERE phone_number = $5', [user.name, user.address, user.birth_date, user.profile_photo, user.phone_number], (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      pool.query('SELECT * FROM users WHERE phone_number = $1', [user.phone_number], (error, results) => {
        if (error) {
          console.warn(error);
          res.status(500).json({ message: 'errore query' })
        } else {
          const userEdited = results.rows[0];
          // Risposta contenente dati utente
          res.json({
            userData: userEdited
          });
        }
      })
    }
  })
};

// Ottengo tutti i badge più le eventuali descrizioni/foto della fase corrente se il progress del badge è ==! null
const getUserBadges = (req, res) => {
  const { userId } = req.body;
  pool.query('SELECT badges.badge_id, COALESCE(badges_detphase.description, badges.description) AS description, COALESCE(badges_detphase.badge_photo, badges.badge_photo) AS badge_photo, badges_detusers.progress, badges_detphase.phase FROM badges LEFT JOIN badges_detusers ON badges.badge_id = badges_detusers.badge_id AND user_id = ' + userId + 'LEFT JOIN badges_detphase ON badges.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress ORDER BY badge_id ', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const userBadges = results.rows
      // Risposta contenente badges utente
      res.json(userBadges);
    }
  })
};

// Aggiunge il badge in badges_detusers se non esiste, altrimenti lo aggiorna
const insertUserBadge = (req, res) => {
  const userData = req.body;
  console.log(userData)
  pool.query('INSERT INTO badges_detusers (user_id, badge_id, progress) VALUES ($1, $2, 1) ON CONFLICT (user_id, badge_id) DO UPDATE SET progress = badges_detusers.progress + 1', [userData.user_id, userData.badge_id], (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      console.log("Badge aggiunto")
      res.status(200).send();
    }
  })
};

// Restituisce solo i badge del partner presenti in badges_detphase (ovvero che hanno almeno fase 1)
const getPartnerBadges = (req, res) => {
  const groupData = req.body;
  console.log(groupData)
  pool.query('SELECT badges_detusers.badge_id, badges_detusers.progress, badges_detphase.badge_photo, badges_detphase.description, badges_detphase.phase FROM badges_detusers INNER JOIN groups_users ON groups_users.userid = badges_detusers.user_id INNER JOIN badges_detphase ON badges_detusers.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress WHERE groups_users.groupid = ' + groupData.groupId + 'AND groups_users.userid <> ' + groupData.userId + 'ORDER BY badge_id', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const partnerBadges = results.rows
      // Risposta contenente i badges del partner
      res.json(partnerBadges);
    }
  })
};

// Restituisce solo i badge del contatto presenti in badges_detphase (ovvero che hanno almeno fase 1)
const getContactBadges = (req, res) => {
  const { userId } = req.body;
  pool.query('SELECT badges_detusers.badge_id, badges_detphase.badge_photo FROM badges_detusers INNER JOIN badges_detphase ON badges_detusers.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress WHERE badges_detusers.user_id = ' + userId + 'ORDER BY badge_id', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const contactBadges = results.rows
      // Risposta contenente i badges del contatto
      res.json(contactBadges);
    }
  })
};

const getFoodAllergies = (request, response) => {
  pool.query('SELECT * FROM food_allergies', (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      console.log("Ecco le intolleranze")
      // Risposta contenente la lista di tutte le intolleranze
      response.status(200).json(results.rows)
    }
  })
};

const getUserFoodAllergies = (req, res) => {
  const { userId } = req.body;
  pool.query('SELECT * FROM food_allergies INNER JOIN allergies_detusers ON food_allergies.allergy_id = allergies_detusers.allergy_id WHERE allergies_detusers.user_id = ' + userId, (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const userAllergies = results.rows
      // Risposta contenente intolleranze utente
      res.json(userAllergies);
    }
  })
};

const getPartnerFoodAllergies = (req, res) => {
  const groupData = req.body;
  pool.query('SELECT * FROM food_allergies INNER JOIN allergies_detusers ON food_allergies.allergy_id = allergies_detusers.allergy_id INNER JOIN groups_users ON allergies_detusers.user_id = groups_users.userid WHERE groupid = ' + groupData.groupId + ' AND userid <> ' + groupData.userId, (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const partnerAllergies = results.rows
      // Risposta contenente intolleranze del partner
      res.json(partnerAllergies);
    }
  })
};

const insertFoodAllergies = (request, response) => {
  const { userAllergy } = request.body;

  pool.query('INSERT INTO allergies_detusers (allergy_id, user_id, allergy_name) VALUES ($1, $2, $3)',
    [userAllergy.allergyId, userAllergy.userId, userAllergy.allergyName], (error) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.log("Intolleranza aggiunta")
        response.status(200).send();
      }
    }
  )
};

const deleteFoodAllergies = (request, response) => {
  const { userAllergy } = request.body;
  pool.query('DELETE FROM allergies_detusers WHERE allergy_id = $1 AND user_id = $2 AND allergy_name = $3',
    [userAllergy.allergyId, userAllergy.userId, userAllergy.allergyName], (error) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        console.log("Intolleranza eliminata")
        response.status(200).send();
      }
    }
  )
};

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

  pool.query('UPDATE users SET firebase_token = NULL WHERE userid = ' + userId, (error, results) => {
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

  // Verifico che l'utente da invitare non appartenga già ad un gruppo
  pool.query('SELECT count(*) FROM groups_users WHERE userid = ' + userIdToInvite, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {

      if (parseInt(results.rows[0]['count']) >= 1) {
        response.status(400).json({ message: 'userId ' + userIdToInvite + ' già presente in un gruppo' })
      } else {
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
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'confirmGroupInvite',
                userIdThatInvites: request.user.userid,
                userNameThatInvites: request.user.name
              };

              // Invio notifica
              sendNotification(userToken, "Nuovo invito",
                "Hai un nuovo invito a partecipare ad un gruppo",
                notificationMsgBody
              );

              response.status(200).send();
            }
          }
        });
      }
    }
  });
};

const inviteGroupConfirm = (request, response) => {
  const { userId: userIdThatInvites } = request.body;

  console.warn("InviteGroupConfirm: " + userIdThatInvites);

  // Verifico che l'utente a cui confermo l'invito non appartenga già ad un gruppo
  pool.query('SELECT count(*) FROM groups_users WHERE userid = ' + userIdThatInvites, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {

      if (parseInt(results.rows[0]['count']) >= 1) {
        response.status(400).json({ message: 'userId ' + userIdThatInvites + ' già presente in un gruppo' })
      } else {
        const sessionUserId = request.user.userid; // Ottengo lo userId dell'utente loggato dalla sessione
        const groupId = '' + sessionUserId + userIdThatInvites; // Genero un groupId concatenando gli userId dei partecipanti

        pool.query('BEGIN', function (err) {
          if (err) return rollback(pool, response, err);
          pool.query('INSERT INTO groups_users (groupid, userid) VALUES ($1, $2)',
            [groupId, sessionUserId], (err) => {
              if (err) return rollback(pool, response, err);
              pool.query('INSERT INTO groups_users (groupid, userid) VALUES ($1, $2)',
                [groupId, userIdThatInvites], (err) => {
                  if (err) return rollback(pool, response, err);

                  pool.query('COMMIT', function () {
                    response.status(200).send();
                  });
                });
            });
        });

        // Ottengo il token dell'utente a cui voglio dare conferma di invito
        pool.query('SELECT * FROM users WHERE userid = ' + userIdThatInvites, (error, results) => {
          if (error) {
            console.log(error);
            response.status(500).json({ message: 'errore query' })
          } else {
            const userToken = results.rows[0]['firebase_token'];
            if (!userToken) { // Non dovrebbe succedere perchè blocchiamo prima di confermare l'aggiunta a gruppo, ma l'utente potrebbe aver fatto logout
              console.warn('Utente non abilitato a ricevere notifiche push');
              response.status(400).json("Utente non abilitato a ricevere notifiche push");
            } else {
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'updateParams'
              };

              // Invio notifica
              sendNotification(userToken, "Invito confermato",
                "L'invito al gruppo è stato confermato",
                notificationMsgBody
              );

              response.status(200).send();
            }
          }
        });
      }
    }
  });
};

const getGroupPartner = (request, res) => {
  const { groupId } = request.body;
  const userId = request.user.userid;

  // Ottengo dati del mio partner escludendo me stesso
  pool.query('SELECT * FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      const partner = results.rows[0]
      console.log("Info partner inviati")
      // Risposta contenente dati utente
      res.json({
        userid: partner.userid,
        name: partner.name,
        address: partner.address,
        phone_number: partner.phone_number,
        birth_date: partner.birth_date,
        profile_photo: partner.profile_photo
      });
    }
  });
}

const leaveGroup = (request, response) => {
  const { groupId } = request.body;
  const userId = request.user.userid;
  var userToken = null; //Token dell'altro utente del mio gruppo

  console.warn("LeaveGroup: " + groupId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      if (results.rows.length > 0) { // Check inserito perchè se l'altro utente fa logout non riesco più ad abbandonare gruppo
        userToken = results.rows[0]['firebase_token']; // Valorizzo il token dell'altro utente che appartiene al gruppo
      }

      // Cancello tutte le entries che hanno il mio gruppo di appartenenza, e anche quelle
      // in cui è presente il mio utente in modo da pulire il DB in caso per errore faccia parte
      // di più gruppi contemporaneamente
      pool.query('DELETE FROM groups_users WHERE groupid = ' + groupId + ' OR userid = ' + userId,
        (error, results) => {
          if (error) {
            console.log(error);
            response.status(500).json({ message: 'errore query' })
          } else {
            if (!userToken) {
              // Non dovrebbe succedere perchè blocchiamo prima di confermare l'aggiunta a gruppo,
              // lascio comunque proseguire, ma l'altro utente non sarà notificato
              console.warn('Utente appartenente a gruppo non più abilitato a ricevere notifiche push');
            } else {
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'updateParams'
              };

              // Invio notifica
              sendNotification(userToken, "Gruppo sciolto",
                "Il gruppo di cui fai parte è stato sciolto",
                notificationMsgBody
              );
            }

            response.status(200).send();
          }
        });
    }
  });
};

const getDinners = (request, response) => {
  console.log("GetDinners - User: " + request.user.userid);
  const dinnersResult = {};
  let myDinnerId = 0; // Id della cena a cui partecipo

  // 1 - MyDinner
  pool.query('SELECT dinners.*, array_agg(DISTINCT dinners_detgroups.groupid) AS groupid FROM dinners INNER JOIN dinners_detgroups ON dinners.dinnerid = dinners_detgroups.dinnerid INNER JOIN groups_users ON dinners_detgroups.groupid = groups_users.groupid GROUP BY dinners.dinnerid HAVING bool_or(groups_users.userid = ' + request.user.userid + ')',
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) {
          // Scelto di selezionare la prima cena di cui fa parte l'utente,
          // anche se teoricamente non può far parte di più cene contemporaneamente
          console.log("MyDinner: ");
          console.log(results.rows);
          myDinnerId = results.rows[0].dinnerid;
          const _dinner = {
            id: results.rows[0].dinnerid,
            title: results.rows[0].dinner_title,
            description: results.rows[0].dinner_description,
            type: results.rows[0].dinner_type,
            groupIds: results.rows[0].groupid,
            date: results.rows[0].dinner_date,
            administrator: results.rows[0].dinner_administrator
          }
          dinnersResult.myDinner = _dinner;
        }

        // 2 - OtherDinners
        pool.query('SELECT dinners.*, array_agg(dinners_detgroups.groupid) AS groupid FROM dinners INNER JOIN dinners_detgroups ON dinners.dinnerid = dinners_detgroups.dinnerid WHERE dinner_date >= NOW() AND dinners.dinnerid <> ' + myDinnerId + ' GROUP BY dinners.dinnerid ORDER BY dinner_date asc',
          (error, results) => {
            if (error) {
              console.warn(error);
              response.status(500).json({ message: 'errore query' })
            } else {
              dinnersResult.otherDinners = [];
              for (var i = 0; i < results.rows.length; i++) {
                const _dinner = {
                  id: results.rows[i].dinnerid,
                  title: results.rows[i].dinner_title,
                  description: results.rows[i].dinner_description,
                  type: results.rows[i].dinner_type,
                  groupIds: results.rows[i].groupid,
                  date: results.rows[i].dinner_date,
                  administrator: results.rows[i].dinner_administrator
                }
                dinnersResult.otherDinners.push(_dinner);
              }

              // Ritorno la mia (eventuale) cena e le altre disponibili
              response.status(200).json(dinnersResult);
            }
          });
      }
    });
};

const getDinnerDetails = (request, response) => {
  const dinnerId = request.body.dinnerId;
  console.log("GetDinnerDetails - Dinner: " + dinnerId);
  const dinnerDetails = {};

  // 1 - Badges
  pool.query('SELECT groups_users.groupid, badges_detusers.badge_id, badges_detusers.progress, badges_detphase.badge_photo, badges_detphase.description FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN badges_detusers ON badges_detusers.user_id = groups_users.userid INNER JOIN badges_detphase ON badges_detusers.badge_id = badges_detphase.badge_id AND badges_detusers.progress >= badges_detphase.min_progress AND badges_detusers.progress <= badges_detphase.max_progress WHERE dinners_detgroups.dinnerid = ' + dinnerId,
    (error, results) => {
      if (error) {
        console.warn(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        dinnerDetails.badges = [];
        for (var i = 0; i < results.rows.length; i++) {
          const _badges = {
            group_id: results.rows[i].groupid,
            badge_id: results.rows[i].badge_id,
            badge_photo: results.rows[i].badge_photo,
            description: results.rows[i].description,
            progress: results.rows[i].progress
          }
          dinnerDetails.badges.push(_badges);
        }

        // 2 - FoodAllergies
        pool.query('SELECT groups_users.userid, allergies_detusers.allergy_id, allergies_detusers.allergy_name, food_allergies.category, food_allergies.allergy_photo FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN allergies_detusers ON allergies_detusers.user_id = groups_users.userid INNER JOIN food_allergies ON food_allergies.allergy_id = allergies_detusers.allergy_id WHERE dinners_detgroups.dinnerid = ' + dinnerId + 'ORDER BY allergies_detusers.allergy_id',
          (error, results) => {
            if (error) {
              console.warn(error);
              response.status(500).json({ message: 'errore query' })
            } else {
              dinnerDetails.foodAllergies = [];
              for (var i = 0; i < results.rows.length; i++) {
                const _foodAllergies = {
                  user_id: results.rows[i].userid,
                  allergy_id: results.rows[i].allergy_id,
                  allergy_name: results.rows[i].allergy_name,
                  allergy_photo: results.rows[i].allergy_photo,
                  category: results.rows[i].category
                }
                dinnerDetails.foodAllergies.push(_foodAllergies);
              }

              // 3 - UsersData
              pool.query('SELECT users.userid, users.name, users.address, users.birth_date, users.profile_photo FROM dinners_detgroups INNER JOIN groups_users ON groups_users.groupid = dinners_detgroups.groupid INNER JOIN users ON groups_users.userid = users.userid WHERE dinners_detgroups.dinnerid = ' + dinnerId + 'ORDER BY users.userid',
                (error, results) => {
                  if (error) {
                    console.warn(error);
                    response.status(500).json({ message: 'errore query' })
                  } else {
                    dinnerDetails.usersData = [];
                    dinnerUsersIds = [];
                    for (var i = 0; i < results.rows.length; i++) {
                      const _usersData = {
                        userId: results.rows[i].userid,
                        name: results.rows[i].name,
                        address: results.rows[i].address,
                        birth_date: results.rows[i].birth_date,
                        profilePhoto: results.rows[i].profile_photo
                      }
                      dinnerDetails.usersData.push(_usersData);
                      dinnerUsersIds.push(_usersData.userId)
                    }
                    const userId = request.body.userId;
                    const userAddress = request.body.userAddress;
                    calcDistance(results.rows, dinnerUsersIds, userId, userAddress).then(res => {
                      dinnerDetails.avgDistance = res
                      response.status(200).json(dinnerDetails);
                    },
                      () => {
                        console.log("Errore in calcDistance")
                        dinnerDetails.avgDistance = "Errore"
                        response.status(200).json(dinnerDetails);
                      })
                  }
                });
            }
          });
      }
    });
};

const createDinner = (request, response) => {
  const { dinnerTitle, dinnerDescription, dinnerType, dinnerDate, groupId } = request.body;
  const userId = request.user.userid;
  const dinnerId = Math.floor(Math.random() * (100000 - 1)) + 1; // Genero dinnerId random per averlo subito invece che farlo generare al DB
  var userToken;

  console.log("Create dinner - dinnerId: " + dinnerId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId,
    (error, results) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) { //Check inserito perchè se l'altro utente fa logout non riesco più a creare la cena
          userToken = results.rows[0]['firebase_token']; //Valorizzo il token dell'altro utente che appartiene al gruppo
        }
      }
    });

  // Gestione inserimento doppio in transazione con eventuale rollback se qualcosa fallisce
  pool.query('BEGIN', function (err) {
    if (err) {
      return rollback(pool, response, err);
    }
    // Creo la cena
    pool.query('INSERT INTO dinners (dinnerid, dinner_type, dinner_date, dinner_description, dinner_title, dinner_administrator) VALUES ($1, $2, $3, $4, $5, $6)',
      [dinnerId, dinnerType, dinnerDate, dinnerDescription, dinnerTitle, groupId], (err) => {
        if (err) return rollback(pool, response, err);

        // Aggiungo il gruppo come primo partecipante della cena
        pool.query('INSERT INTO dinners_detgroups (dinnerid, groupid) VALUES ($1, $2)',
          [dinnerId, groupId], (err) => {
            if (err) return rollback(pool, response, err);

            pool.query('COMMIT', function () {
              if (userToken) { // Verifico che l'altro utente del gruppo abbia un token valido per inviargli la notifica
                // Genero le informazioni da inviare nella notifica
                const notificationMsgBody = {
                  type: 'updateParams'
                };

                // Invio notifica
                sendNotification(userToken, "Creazione cena",
                  "Una nuova RunningDinner è stata creata",
                  notificationMsgBody
                );
              }

              response.status(201).send();
            });
          });
      });
  });
};

const leaveDinner = (request, response) => {
  const { groupId, dinnerId } = request.body;
  const userId = request.user.userid;
  var userToken = null; //Token dell'altro utente del mio gruppo

  const sendLeaveDinnerNotification = function (userToken) {
    if (!userToken) {
      // L'altro utente non sarà notificato della rimozione dalla cena
      console.warn('Utente appartenente a gruppo non più abilitato a ricevere notifiche push');
    } else {
      // Genero le informazioni da inviare nella notifica
      const notificationMsgBody = {
        type: 'updateParams'
      };
      // Invio notifica
      sendNotification(userToken, "Cena abbandonata",
        "Il tuo gruppo ha abbandonato la cena a cui partecipavi",
        notificationMsgBody
      );
    }
  };

  console.log("[LeaveDinner] GroupId: " + groupId + " , DinnerId: " + dinnerId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId, (error, results) => {
    if (error) {
      console.log(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      if (results.rows.length > 0) { // Check inserito perchè se l'altro utente fa logout non riesco più ad abbandonare la cena
        userToken = results.rows[0]['firebase_token']; // Valorizzo il token dell'altro utente che appartiene al gruppo
      }

      // Ottengo il numero degli altri gruppi partecipanti alla cena
      pool.query('SELECT * FROM dinners_detgroups WHERE dinners_detgroups.dinnerid = ' + dinnerId + ' AND dinners_detgroups.groupid <> ' + groupId, (error, results) => {
        if (error) {
          console.log(error);
          response.status(500).json({ message: 'errore query' })
        } else {
          pool.query('BEGIN', function (err) {
            if (err) return rollback(pool, response, err);

            // Rimuovo il gruppo dalla cena
            pool.query('DELETE FROM dinners_detgroups WHERE groupid = ' + groupId,
              (error) => {
                if (error) return rollback(pool, response, error);

                if (results.rows.length == 0) { // Il mio gruppo era l'unico partecipante alla cena, cancello il mio gruppo e la cena
                  console.log("Un gruppo solo, cancello cena");

                  // Cancello la cena
                  pool.query('DELETE FROM dinners WHERE dinnerid = ' + dinnerId,
                    (error) => {
                      if (error) return rollback(pool, response, error);

                      sendLeaveDinnerNotification(userToken);

                      pool.query('COMMIT', function () {
                        response.status(200).send();
                      });
                    });
                } else {

                  pool.query('SELECT dinner_administrator FROM dinners WHERE dinnerid = ' + dinnerId, (error, results) => {
                    if (results.rows[0]['dinner_administrator'] == groupId) {
                      console.log("Più gruppi e sono amministratore, eleggo nuovo amministratore cena");

                      // Seleziono il nuovo gruppo amministratore della cena prendendo il primo altro gruppo in tabella (dovrebbe essere in ordine di inserimento)
                      pool.query('UPDATE dinners SET dinner_administrator = (select groupid FROM dinners_detgroups WHERE dinnerid = ' + dinnerId + ' fetch first 1 rows only) WHERE dinnerid = ' + dinnerId,
                        (error) => {
                          if (error) return rollback(pool, response, error);

                          sendLeaveDinnerNotification(userToken);

                          pool.query('COMMIT', function () {
                            response.status(200).send();
                          });
                        });
                    } else {
                      console.log("Più gruppi e non sono amministratore, abbandono semplicemente");

                      sendLeaveDinnerNotification(userToken);

                      pool.query('COMMIT', function () {
                        response.status(200).send();
                      });
                    }

                  });
                }
              });
          });
        }
      });
    }
  });
};

const joinDinner = (request, response) => {
  const { groupId, dinnerId } = request.body;
  const userId = request.user.userid;
  var userToken = null; //Token dell'altro utente del mio gruppo

  console.log("[JoinDinner] GroupId: " + groupId + " , DinnerId: " + dinnerId);

  //Ottengo il token di chi fa parte del mio gruppo escludendo me stesso
  pool.query('SELECT users.firebase_token FROM users INNER JOIN groups_users ON users.userid = groups_users.userid WHERE groups_users.groupid = ' + groupId + ' AND groups_users.userid <> ' + userId,
    (error, results) => {
      if (error) {
        console.log(error);
        response.status(500).json({ message: 'errore query' })
      } else {
        if (results.rows.length > 0) { //Check inserito perchè se l'altro utente fa logout non riesco più a creare la cena
          userToken = results.rows[0]['firebase_token']; //Valorizzo il token dell'altro utente che appartiene al gruppo
        }

        // Aggiungo il gruppo alla cena
        pool.query('INSERT INTO dinners_detgroups (dinnerid, groupid) VALUES ($1, $2)',
          [dinnerId, groupId], (err) => {

            if (!userToken) {
              // L'altro utente non sarà notificato della rimozione dalla cena
              console.warn('Utente appartenente a gruppo non più abilitato a ricevere notifiche push');
            } else {
              // Genero le informazioni da inviare nella notifica
              const notificationMsgBody = {
                type: 'updateParams'
              };
              // Invio notifica
              sendNotification(userToken, "Cena abbandonata",
                "Il tuo gruppo ha abbandonato la cena a cui partecipavi",
                notificationMsgBody
              );
            }

            response.status(201).send();
          });
      }
    });
};

const updateDinner = (request, response) => {
  const { dinnerId, title, description } = request.body;
  const userId = request.user.userid;

  // Aggiorno informazioni sulla cena
  pool.query('UPDATE dinners SET dinner_title = $1, dinner_description = $2 WHERE dinnerid = $3', [title, description, dinnerId], (error, results) => {
    if (error) {
      console.warn(error);
      response.status(500).json({ message: 'errore query' })
    } else {
      // Ottengo l'elenco dei token dei partecipanti alla cena a parte me
      // TODO

      response.status(200).send();
    }
  })
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
  .post(updateUser)

//ExistsUser
app
  .route('/existsUser')
  .post(checkUserExists)

//GetUserBadges
app
  .route('/getUserBadges')
  .post(getUserBadges)

//InsertUserBadge
app
  .route('/insertUserBadge')
  .post(insertUserBadge)

//GetPartnerBadges
app
  .route('/getPartnerBadges')
  .post(getPartnerBadges)

//GetContactBadges
app
  .route('/getContactBadges')
  .post(getContactBadges)

//GetFoodAllergies
app
  .route('/getFoodAllergies')
  .get(getFoodAllergies)

//GetUserFoodAllergies
app
  .route('/getUserFoodAllergies')
  .post(getUserFoodAllergies)

//GetPartnerFoodAllergies
app
  .route('/getPartnerFoodAllergies')
  .post(getPartnerFoodAllergies)

//UpdateFoodAllergies
app
  .route('/insertFoodAllergies')
  .post(insertFoodAllergies)

//DeleteFoodAllergies
app
  .route('/deleteFoodAllergies')
  .post(deleteFoodAllergies)

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

//InviteGroupConfirm
app
  .route('/inviteGroupConfirm')
  .post(authenticateJWT, inviteGroupConfirm);

//getGroupPartner
app
  .route('/getGroupPartner')
  .post(authenticateJWT, getGroupPartner);

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
  .get(authenticateJWT, getDinners) // GET endpoint to obtail dinners
  .post(authenticateJWT, createDinner) // POST endpoint to create dinner
  .put(authenticateJWT, updateDinner) // PUT endpoint to update dinner

//Dinner details
app
  .route('/getDinnerDetails')
  .post(authenticateJWT, getDinnerDetails)

//Leaver dinner
app
  .route('/leaveDinner')
  .post(authenticateJWT, leaveDinner)

//Join dinner
app
  .route('/joinDinner')
  .post(authenticateJWT, joinDinner)

//RunQuery
app
  .route('/runQuery')
  .post(authenticateJWT, runQuery);

//--------Run--------//

// Start Server
app.listen(process.env.PORT || 1111, () => {
  console.log(`Server listening`)
})
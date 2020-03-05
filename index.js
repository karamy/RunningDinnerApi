//--------Dependencies-------//
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')
const jwt = require('jsonwebtoken');

//--------Initialization--------//
const app = express()
const accessTokenSecret = 'carloebbasta';
/* const refreshTokenSecret = 'refreshcarloebbasta';
const refreshTokens = []; */
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors()) //Utilizzo libreria CORS per configurare domini da cui ricevere chiamata (nel caso dell'app devo impostare ALL)

console.warn("App Avviata: versione " + process.env.VERSION);

//--------Routes-------//
const getUsers = (request, response) => {
  pool.query('SELECT * FROM users', (error, results) => {
    if (error) {
      console.warn(error); 
      response.status(500).json({message: 'errore query'})
    } else {
      response.status(200).json(results.rows) 
    }
  })
}
const addUser = (request, response) => {
  const { name, address, phone_number, age } = request.body

  pool.query('INSERT INTO users (name, address, phone_number, age) VALUES ($1, $2, $3, $4)', [name, address, phone_number, age], error => {
    if (error) {
      console.warn(error); 
      response.status(500).json({message: 'errore query'})
    } else {
      response.status(201).json({ status: 'success', message: 'User added.' })
    }
  })
}
const checkUserExists = (request, response) => {
  const { phone_number } = request.body;

  pool.query('SELECT count(*) FROM users WHERE phone_number =\'' + phone_number+'\'', (error, results) => {
    if (error) {
      response.status(500).json({message: 'errore query'})
    } else {
      response.status(200).json(results.rows[0].count == 1) 
    }
  })
}

//Authorization Middleware
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (authHeader) {
      const token = authHeader.split(' ')[1];

      jwt.verify(token, accessTokenSecret, (err, user) => {
          if (err) {
              return res.sendStatus(403);
          }

          req.user = user;
          next();
      });
  } else {
      res.sendStatus(401);
  }
};

//Users
app
  .route('/users')
  .get(authenticateJWT, getUsers) // GET endpoint to list Users
  .post(addUser) // POST endpoint to add User

//ExistsUser
app
  .route('/existsUser')
  .post(checkUserExists)

//Login
app.post('/login', (req, res) => {
    const { phone_number } = req.body;

    pool.query('SELECT * FROM users WHERE phone_number =\'' + phone_number+'\'', (error, results) => {
      if (error) {
        response.status(500).json({message: 'errore query'})
      } else {
        user = results.rows[0];
        if (user) {
          // Generate an access token
          const accessToken = jwt.sign({ username: user.username,  role: user.role }, accessTokenSecret);
          // Risposta contenente token e dati utente
          res.json({
              accessToken,
              user
          });
      } else {
          res.send('Incorrect credentials o.O');
      }
      }
    })
});

// Start Server
app.listen(process.env.PORT || 3002, () => {
  console.log(`Server listening`)
})
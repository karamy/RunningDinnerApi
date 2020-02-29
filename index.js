const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { pool } = require('./config')

const app = express()

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors()) //Utilizzo libreria CORS per configurare domini da cui ricevere chiamata (nel caso dell'app devo impostare ALL)

const getUsers = (request, response) => {
  pool.query('SELECT * FROM users', (error, results) => {
    if (error) {
      throw error
    }
    response.status(200).json(results.rows) 
  })
}

const addUser = (request, response) => {
  const { userId, name, address } = request.body

  pool.query('INSERT INTO users (userId, name, address) VALUES ($1, $2, $3)', [userId, name, address], error => {
    if (error) {
      throw error
    }
    response.status(201).json({ status: 'success', message: 'User added.' })
  })
}

const checkUserExists = (request, response) => {
  const { phone_number } = request.body;

  console.warn(request.body);
  pool.query('SELECT count(*) FROM users WHERE phone_number =\'' + phone_number+'\'', (error, results) => {
    if (error) {
      throw error
    }
    response.status(200).json(results.rows[0].count == 1) 
  })
}

//Define routes
app
  .route('/users')
  .get(getUsers) // GET endpoint to list Users
  .post(addUser) // POST endpoint to add User

app
  .route('/existsUser')
  .post(checkUserExists)

// Start server
app.listen(process.env.PORT || 3002, () => {
  console.log(`Server listening`)
})